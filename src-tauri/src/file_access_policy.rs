use super::AccessError;
use std::path::{Component, Path};

pub(super) fn supported_platform() -> Result<(), AccessError> {
    if cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )) {
        Ok(())
    } else {
        Err(AccessError::UnsupportedPlatform)
    }
}

pub(super) fn validate_native_selection(path: &Path) -> Result<(), AccessError> {
    if !path.is_absolute() {
        return Err(AccessError::InvalidPath);
    }
    // Prefixes are accepted only from a trusted native selection, never from
    // relative operation input. Block device namespaces and ADS nonetheless.
    for component in path.components() {
        match component {
            Component::ParentDir => return Err(AccessError::InvalidPath),
            Component::Normal(name) => {
                validate_name(name.to_str().ok_or(AccessError::InvalidPath)?)?
            }
            #[cfg(windows)]
            Component::Prefix(prefix)
                if !matches!(
                    prefix.kind(),
                    std::path::Prefix::Disk(_)
                        | std::path::Prefix::VerbatimDisk(_)
                        | std::path::Prefix::UNC(_, _)
                        | std::path::Prefix::VerbatimUNC(_, _)
                ) =>
            {
                return Err(AccessError::InvalidPath)
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), AccessError> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name.chars().any(|c| {
            c.is_control() || matches!(c, ':' | '\\' | '/' | '<' | '>' | '"' | '|' | '?' | '*')
        })
    {
        return Err(AccessError::InvalidPath);
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|tail| {
                matches!(
                    tail,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
    {
        return Err(AccessError::InvalidPath);
    }
    Ok(())
}

pub(super) fn validate_relative(path: &Path) -> Result<(), AccessError> {
    let raw = path.to_str().ok_or(AccessError::InvalidPath)?;
    // Check the raw string too: Path::components normalizes embedded `.`.
    for name in raw.split('/') {
        validate_name(name)?;
    }
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AccessError::InvalidPath);
    }
    Ok(())
}
