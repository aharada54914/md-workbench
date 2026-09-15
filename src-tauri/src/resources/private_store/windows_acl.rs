//! Shared strict private-store policy. Unknown ACE forms fail closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    InvalidSecurityDescriptor,
    BoundedBufferExceeded,
    UnsupportedTokenIdentity,
    PrivilegedToken,
    ForeignOwner,
    NullOrMissingDacl,
    UnprotectedDacl,
    UnexpectedAcl,
}
impl std::fmt::Display for Reason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Reason {}
use std::{
    ffi::c_void,
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::{
    Foundation::{LocalFree, ERROR_INSUFFICIENT_BUFFER},
    Security::{Authorization::*, *},
    Storage::FileSystem::FILE_ALL_ACCESS,
    System::{
        SystemServices::ACCESS_ALLOWED_ACE_TYPE,
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

pub fn error(reason: impl std::error::Error + Send + Sync + 'static) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}
pub fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

// Own every allocation returned by the security APIs, including error paths.
pub struct Local(pub *mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub struct Identity {
    pub sid: String,
    pub elevated: bool,
}
fn token_buffer(token: &OwnedHandle, class: TOKEN_INFORMATION_CLASS) -> io::Result<Vec<usize>> {
    let mut length = 0;
    let ok = unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            class,
            ptr::null_mut(),
            0,
            &mut length,
        )
    };
    if ok != 0 {
        return Err(error(Reason::InvalidSecurityDescriptor));
    }
    let sizing_error = io::Error::last_os_error();
    if sizing_error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
        return Err(sizing_error);
    }
    if length == 0 || length > 65536 {
        return Err(error(Reason::BoundedBufferExceeded));
    }
    // usize alignment accommodates TOKEN_USER and TOKEN_PRIVILEGES on x64/ARM64.
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    check(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            class,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    })?;
    Ok(buffer)
}
fn sid_string(sid: PSID) -> io::Result<String> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(error(Reason::InvalidSecurityDescriptor));
    }
    let mut value = Local(ptr::null_mut());
    check(unsafe { ConvertSidToStringSidW(sid, (&mut value.0 as *mut *mut c_void).cast()) })?;
    // A valid SID string is bounded by SID_MAX_SUB_AUTHORITIES and DWORD decimal digits.
    let start = value.0.cast::<u16>();
    let mut units = Vec::new();
    for index in 0..192 {
        let unit = unsafe { *start.add(index) };
        if unit == 0 {
            return String::from_utf16(&units)
                .map_err(|_| error(Reason::InvalidSecurityDescriptor));
        }
        units.push(unit);
    }
    Err(error(Reason::BoundedBufferExceeded))
}

fn token_elevated(token: &OwnedHandle) -> io::Result<bool> {
    // This class has a fixed-size result. A NULL/zero sizing query can fail
    // with ERROR_BAD_LENGTH rather than the variable-size helper's error.
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut returned = 0;
    check(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    })?;
    if returned as usize != size_of::<TOKEN_ELEVATION>() {
        return Err(error(Reason::InvalidSecurityDescriptor));
    }
    Ok(elevation.TokenIsElevated != 0)
}

pub fn identity() -> io::Result<Identity> {
    let mut raw = ptr::null_mut();
    check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) })?;
    let token = unsafe { OwnedHandle::from_raw_handle(raw) };
    let user = token_buffer(&token, TokenUser)?;
    let sid = sid_string(unsafe { (*(user.as_ptr().cast::<TOKEN_USER>())).User.Sid })?;
    if sid == "S-1-5-18" {
        return Err(error(Reason::UnsupportedTokenIdentity));
    }
    let elevated = token_elevated(&token)?;
    let privileges = token_buffer(&token, TokenPrivileges)?;
    let p = privileges.as_ptr().cast::<TOKEN_PRIVILEGES>();
    let count = unsafe { (*p).PrivilegeCount } as usize;
    let offset = std::mem::offset_of!(TOKEN_PRIVILEGES, Privileges);
    if count > (privileges.len() * size_of::<usize>() - offset) / size_of::<LUID_AND_ATTRIBUTES>() {
        return Err(error(Reason::InvalidSecurityDescriptor));
    }
    for name in ["SeBackupPrivilege", "SeRestorePrivilege"] {
        let mut luid = unsafe { std::mem::zeroed() };
        check(unsafe { LookupPrivilegeValueW(ptr::null(), wide(name).as_ptr(), &mut luid) })?;
        for index in 0..count {
            let privilege = unsafe { *(*p).Privileges.as_ptr().add(index) };
            if privilege.Luid.LowPart == luid.LowPart
                && privilege.Luid.HighPart == luid.HighPart
                && privilege.Attributes & SE_PRIVILEGE_ENABLED != 0
            {
                return Err(error(Reason::PrivilegedToken));
            }
        }
    }
    Ok(Identity { sid, elevated })
}

pub fn descriptor(sddl: &str) -> io::Result<Local> {
    let mut sd = Local(ptr::null_mut());
    check(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(sddl).as_ptr(),
            SDDL_REVISION_1,
            &mut sd.0,
            ptr::null_mut(),
        )
    })?;
    Ok(sd)
}
pub fn protected_null_descriptor(user: &str) -> io::Result<Local> {
    let sd = descriptor(&format!("O:{user}D:NO_ACCESS_CONTROL"))?;
    // Modify only this in-memory fixture before creation. Otherwise its parent's
    // inheritable ACEs could turn the intended NULL DACL into a non-NULL DACL.
    check(unsafe { SetSecurityDescriptorControl(sd.0, SE_DACL_PROTECTED, SE_DACL_PROTECTED) })?;
    Ok(sd)
}
pub fn private_sddl(user: &str, directory: bool) -> String {
    let flags = if directory { "OICI" } else { "" };
    format!("O:{user}D:P(A;{flags};FA;;;{user})(A;{flags};FA;;;SY)")
}
pub fn attributes(sd: &Local) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    }
}

pub fn inspect(handle: &impl AsRawHandle, user: &str, directory: bool) -> io::Result<()> {
    let mut sd = Local(ptr::null_mut());
    let code = unsafe {
        GetSecurityInfo(
            handle.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut sd.0,
        )
    };
    if code != 0 {
        return Err(io::Error::from_raw_os_error(code as i32));
    }
    validate_descriptor(&sd, user, directory)
}

fn validate_descriptor(sd: &Local, user: &str, directory: bool) -> io::Result<()> {
    // The OS-owned self-relative descriptor remains alive for every borrowed pointer.
    if unsafe { IsValidSecurityDescriptor(sd.0) } == 0 {
        return Err(error(Reason::InvalidSecurityDescriptor));
    }
    let (mut owner, mut defaulted) = (ptr::null_mut(), 0);
    check(unsafe { GetSecurityDescriptorOwner(sd.0, &mut owner, &mut defaulted) })?;
    if sid_string(owner)? != user {
        return Err(error(Reason::ForeignOwner));
    }
    let (mut acl, mut present) = (ptr::null_mut(), 0);
    check(unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut acl, &mut defaulted) })?;
    if present == 0 || acl.is_null() {
        return Err(error(Reason::NullOrMissingDacl));
    }
    let (mut control, mut revision) = (0, 0);
    check(unsafe { GetSecurityDescriptorControl(sd.0, &mut control, &mut revision) })?;
    if control & SE_DACL_PROTECTED == 0 {
        return Err(error(Reason::UnprotectedDacl));
    }
    if unsafe { IsValidAcl(acl) } == 0 {
        return Err(error(Reason::InvalidSecurityDescriptor));
    }
    if unsafe { (*acl).AceCount } != 2 {
        return Err(error(Reason::UnexpectedAcl));
    }
    let expected_flags = if directory {
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
    } else {
        0
    };
    let (mut found_user, mut found_system) = (false, false);
    for index in 0..2 {
        let mut raw = ptr::null_mut();
        check(unsafe { GetAce(acl, index, &mut raw) })?;
        let header = unsafe { &*raw.cast::<ACE_HEADER>() };
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
            || u32::from(header.AceFlags) != expected_flags
            || (header.AceSize as usize) < size_of::<ACCESS_ALLOWED_ACE>()
        {
            return Err(error(Reason::UnexpectedAcl));
        }
        let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
        if ace.Mask != FILE_ALL_ACCESS {
            return Err(error(Reason::UnexpectedAcl));
        }
        let sid = (&ace.SidStart as *const u32).cast_mut().cast();
        let principal = sid_string(sid)?;
        if principal == user && !found_user {
            found_user = true;
        } else if principal == "S-1-5-18" && !found_system {
            found_system = true;
        } else {
            return Err(error(Reason::UnexpectedAcl));
        }
    }
    if !found_user || !found_system {
        return Err(error(Reason::UnexpectedAcl));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const USER: &str = "S-1-5-21-1-2-3-1001";

    fn process_token() -> OwnedHandle {
        let mut raw = ptr::null_mut();
        check(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) }).unwrap();
        unsafe { OwnedHandle::from_raw_handle(raw) }
    }
    // Exercise each actual query separately so a sizing failure is attributed
    // without logging the user's SID or privilege list. These are API tests;
    // the probe's identity() still independently rejects unsafe identities.
    #[test]
    fn current_process_user_query() {
        let token = process_token();
        let user = token_buffer(&token, TokenUser).unwrap();
        let sid = unsafe { (*(user.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        assert!(!sid_string(sid).unwrap().is_empty());
    }
    #[test]
    fn current_process_privileges_query() {
        let token = process_token();
        let privileges = token_buffer(&token, TokenPrivileges).unwrap();
        assert!(
            privileges.len() * size_of::<usize>()
                >= std::mem::offset_of!(TOKEN_PRIVILEGES, Privileges)
        );
    }
    #[test]
    fn current_process_elevation_uses_fixed_size_buffer() {
        token_elevated(&process_token()).unwrap();
    }

    #[test]
    fn null_fixture_is_protected_before_file_creation() {
        let sd = protected_null_descriptor(USER).unwrap();
        let (mut acl, mut present, mut defaulted) = (ptr::null_mut(), 0, 0);
        check(unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut acl, &mut defaulted) })
            .unwrap();
        assert_ne!(present, 0);
        assert!(acl.is_null());
        let (mut control, mut revision) = (0, 0);
        check(unsafe { GetSecurityDescriptorControl(sd.0, &mut control, &mut revision) }).unwrap();
        assert_ne!(control & SE_DACL_PROTECTED, 0);
        let error = validate_descriptor(&sd, USER, false).unwrap_err();
        assert_eq!(
            error.get_ref().unwrap().downcast_ref::<Reason>(),
            Some(&Reason::NullOrMissingDacl)
        );
    }
    #[test]
    fn strict_descriptor_policy_accepts_only_the_deliberate_form() {
        for directory in [false, true] {
            validate_descriptor(
                &descriptor(&private_sddl(USER, directory)).unwrap(),
                USER,
                directory,
            )
            .unwrap();
        }
        for (sddl, reason) in [
            (
                format!("O:SYD:P(A;;FA;;;{USER})(A;;FA;;;SY)"),
                Reason::ForeignOwner,
            ),
            (format!("O:{USER}"), Reason::NullOrMissingDacl),
            (
                format!("O:{USER}D:NO_ACCESS_CONTROL"),
                Reason::NullOrMissingDacl,
            ),
            (
                format!("O:{USER}D:(A;;FA;;;{USER})(A;;FA;;;SY)"),
                Reason::UnprotectedDacl,
            ),
            (
                format!("O:{USER}D:P(A;;FA;;;{USER})(A;;FA;;;WD)"),
                Reason::UnexpectedAcl,
            ),
            (
                format!("O:{USER}D:P(A;;FR;;;{USER})(A;;FA;;;SY)"),
                Reason::UnexpectedAcl,
            ),
            (
                format!("O:{USER}D:P(A;;FA;;;{USER})(A;;FA;;;{USER})"),
                Reason::UnexpectedAcl,
            ),
            (
                format!("O:{USER}D:P(A;ID;FA;;;{USER})(A;;FA;;;SY)"),
                Reason::UnexpectedAcl,
            ),
        ] {
            let error = validate_descriptor(&descriptor(&sddl).unwrap(), USER, false).unwrap_err();
            assert_eq!(
                error.get_ref().unwrap().downcast_ref::<Reason>(),
                Some(&reason)
            );
        }
    }
}
