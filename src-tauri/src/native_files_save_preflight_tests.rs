use super::*;
use crate::file_access::{Rights, MAX_IO_BYTES};
use sha2::{Digest, Sha256};
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new(bytes: &[u8]) -> Self {
        let root = std::env::temp_dir().join(format!("mdw-save-preflight-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("doc.md"), bytes).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn path(&self) -> String {
        self.0.join("doc.md").to_str().unwrap().into()
    }
    fn state(&self) -> (NativeState, Uuid, GrantId) {
        let mut state = NativeState::default();
        state.register("main").unwrap();
        state.register("window-1").unwrap();
        let generation = state.generation("main").unwrap();
        let selected = state
            .select(
                "main",
                generation,
                vec![self.path().into()],
                Purpose::Document,
            )
            .unwrap();
        (state, generation, GrantId::parse(&selected[0].id).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn hash(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
fn check(
    state: &NativeState,
    fixture: &Fixture,
    generation: Uuid,
    id: GrantId,
    before: &[u8],
    candidate: &[u8],
) -> Result<SavePreflightObservation, String> {
    state.preflight_document_save(
        "main",
        generation,
        &fixture.path(),
        id,
        hash(before),
        candidate,
    )
}

#[test]
fn stale_hash_rejected_without_mutating_document_or_creating_siblings() {
    let fixture = Fixture::new(b"external change");
    let (state, generation, id) = fixture.state();
    assert_eq!(
        check(&state, &fixture, generation, id, b"original", b"candidate")
            .err()
            .unwrap(),
        "stale_disk"
    );
    assert_eq!(fs::read(fixture.path()).unwrap(), b"external change");
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
}

#[test]
fn exact_bytes_are_observed_without_utf8_decoding_or_newline_normalization() {
    let before = b"\xef\xbb\xbf# Before\r\n \r\n\xff\x00";
    let candidate = b"\xef\xbb\xbf# After\r\n\xfe\x00";
    let fixture = Fixture::new(before);
    let (state, generation, id) = fixture.state();
    let observation = check(&state, &fixture, generation, id, before, candidate).unwrap();
    assert_eq!(observation.before(), before);
    assert_eq!(observation.candidate(), candidate);
    assert_eq!(observation.before_hash(), &hash(before));
    assert_eq!(observation.candidate_hash(), &hash(candidate));
    assert_eq!(fs::read(fixture.path()).unwrap(), before);
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
}

#[test]
fn observation_does_not_follow_future_edits_or_grant_lifecycle() {
    let fixture = Fixture::new(b"old");
    let (mut state, generation, id) = fixture.state();
    let mut candidate = b"new".to_vec();
    let observed = check(&state, &fixture, generation, id, b"old", &candidate).unwrap();
    candidate.fill(b'x');
    fs::write(fixture.path(), b"external").unwrap();
    state.revoke("main");
    assert_eq!(observed.before(), b"old");
    assert_eq!(observed.candidate(), b"new");
    assert_eq!(fs::read(fixture.path()).unwrap(), b"external");
}

#[test]
fn generation_revocation_reuse_and_other_windows_cannot_use_the_selection() {
    let fixture = Fixture::new(b"old");
    let (mut state, generation, id) = fixture.state();
    for label in ["window-1", "preview", "print", "window-preview"] {
        let caller_generation = state.generation(label).unwrap_or(generation);
        assert_eq!(
            state
                .preflight_document_save(
                    label,
                    caller_generation,
                    &fixture.path(),
                    id,
                    hash(b"old"),
                    b"new"
                )
                .err()
                .unwrap(),
            "permission_required"
        );
    }
    assert!(state.register("preview").is_err());
    assert!(state.register("print").is_err());
    assert_eq!(
        check(&state, &fixture, Uuid::new_v4(), id, b"old", b"new")
            .err()
            .unwrap(),
        "permission_required"
    );
    state.revoke("main");
    assert!(check(&state, &fixture, generation, id, b"old", b"new").is_err());
    state.register("main").unwrap();
    let new_generation = state.generation("main").unwrap();
    let selected = state
        .select(
            "main",
            new_generation,
            vec![fixture.path().into()],
            Purpose::Document,
        )
        .unwrap();
    let new_id = GrantId::parse(&selected[0].id).unwrap();
    assert!(check(&state, &fixture, generation, new_id, b"old", b"new").is_err());
    assert!(check(&state, &fixture, new_generation, id, b"old", b"new").is_err());
    assert!(check(&state, &fixture, new_generation, new_id, b"old", b"new").is_ok());
}

#[test]
fn same_path_reselection_does_not_resurrect_a_retained_older_id() {
    let fixture = Fixture::new(b"old");
    let (mut state, generation, old_id) = fixture.state();
    let selected = state
        .select(
            "main",
            generation,
            vec![fixture.path().into()],
            Purpose::Document,
        )
        .unwrap();
    let new_id = GrantId::parse(&selected[0].id).unwrap();
    // The old core handle still exists; only current metadata may authorize preflight.
    assert!(state.access.describe("main", old_id).is_ok());
    assert!(check(&state, &fixture, generation, old_id, b"old", b"new").is_err());
    assert!(check(&state, &fixture, generation, new_id, b"old", b"new").is_ok());
}

#[test]
fn save_export_keeps_current_document_binding_but_cannot_supply_preflight() {
    let fixture = Fixture::new(b"old");
    let (mut state, generation, id) = fixture.state();
    let selected = state
        .select(
            "main",
            generation,
            vec![fixture.path().into()],
            Purpose::Save,
        )
        .unwrap();
    let export_id = GrantId::parse(&selected[0].id).unwrap();
    assert!(check(&state, &fixture, generation, id, b"old", b"new").is_ok());
    assert!(check(&state, &fixture, generation, export_id, b"old", b"new").is_err());
    state.owned.clear();
    assert!(state.lookup("main", &fixture.path()).unwrap().is_some()); // Save-only lookup fallback
    assert!(check(&state, &fixture, generation, export_id, b"old", b"new").is_err());
}

#[test]
fn resource_reselection_and_workspace_read_do_not_supply_document_write_authority() {
    let fixture = Fixture::new(b"old");
    let (mut state, generation, old_id) = fixture.state();
    let selected = state
        .select(
            "main",
            generation,
            vec![fixture.path().into()],
            Purpose::Resource,
        )
        .unwrap();
    let resource_id = GrantId::parse(&selected[0].id).unwrap();
    assert!(check(&state, &fixture, generation, old_id, b"old", b"new").is_err());
    assert!(check(&state, &fixture, generation, resource_id, b"old", b"new").is_err());
    state.owned.clear();
    let selected = state
        .select(
            "main",
            generation,
            vec![fixture.0.clone()],
            Purpose::Workspace,
        )
        .unwrap();
    let workspace_id = GrantId::parse(&selected[0].id).unwrap();
    assert!(state
        .resolve_owned_path("main", &fixture.path(), false)
        .is_ok());
    assert!(check(&state, &fixture, generation, workspace_id, b"old", b"new").is_err());
    assert!(state
        .preflight_document_save(
            "main",
            generation,
            fixture.0.to_str().unwrap(),
            workspace_id,
            hash(b"old"),
            b"new"
        )
        .is_err());
}

#[test]
fn same_grant_must_have_both_rights_even_if_metadata_claims_more() {
    let fixture = Fixture::new(b"old");
    let (mut state, generation, _) = fixture.state();
    for rights in [Rights::READ, Rights::WRITE] {
        let info = state
            .access
            .grant_file_from_native_selection(
                "main",
                Path::new(&fixture.path()),
                GrantKind::Document,
                rights,
            )
            .unwrap();
        state.remember("main", Path::new(&fixture.path()), info.clone());
        assert!(check(&state, &fixture, generation, info.id, b"old", b"new").is_err());
        for ((owner, _), metadata) in &mut state.owned {
            if owner == "main" && metadata.id == info.id {
                metadata.rights = Rights::READ_WRITE;
            }
        }
        assert!(check(&state, &fixture, generation, info.id, b"old", b"new").is_err());
    }
}

#[test]
fn core_rejects_non_document_kind_even_with_read_write_rights() {
    let fixture = Fixture::new(b"old");
    let (mut state, _, _) = fixture.state();
    for kind in [GrantKind::Resource, GrantKind::Export] {
        let info = state
            .access
            .grant_file_from_native_selection(
                "main",
                Path::new(&fixture.path()),
                kind,
                Rights::READ_WRITE,
            )
            .unwrap();
        assert_eq!(
            state
                .access
                .preflight_document_save("main", info.id, hash(b"old"), b"new")
                .err()
                .unwrap(),
            "invalid_grant_kind"
        );
    }
}

#[test]
fn unselected_spelling_and_revoked_core_grant_never_fall_back_to_ambient_path() {
    let fixture = Fixture::new(b"old");
    let (mut state, generation, id) = fixture.state();
    let spelled = format!("{}/./doc.md", fixture.0.display());
    assert_eq!(fs::read(&spelled).unwrap(), b"old");
    assert!(state
        .preflight_document_save("main", generation, &spelled, id, hash(b"old"), b"new")
        .is_err());
    let unknown = GrantId::parse(&Uuid::new_v4().to_string()).unwrap();
    assert!(check(&state, &fixture, generation, unknown, b"old", b"new").is_err());
    state.access.revoke("main", id);
    assert_eq!(
        check(&state, &fixture, generation, id, b"old", b"new")
            .err()
            .unwrap(),
        "permission_required"
    );
}

#[test]
fn requested_and_canonical_native_aliases_remain_usable() {
    let fixture = Fixture::new(b"old");
    let (mut state, generation, _) = fixture.state();
    let requested = format!("{}/./doc.md", fixture.0.display());
    let selected = state
        .select(
            "main",
            generation,
            vec![requested.clone().into()],
            Purpose::Document,
        )
        .unwrap();
    let id = GrantId::parse(&selected[0].id).unwrap();
    assert!(state
        .preflight_document_save("main", generation, &requested, id, hash(b"old"), b"new")
        .is_ok());
    assert!(check(&state, &fixture, generation, id, b"old", b"new").is_ok());
}

#[test]
fn empty_is_observable_but_missing_or_directory_leaf_is_not_a_missing_prior_save() {
    let fixture = Fixture::new(b"");
    let (state, generation, id) = fixture.state();
    let observed = check(&state, &fixture, generation, id, b"", b"").unwrap();
    assert!(observed.before().is_empty());
    assert_eq!(observed.before_hash(), &hash(b""));
    fs::remove_file(fixture.path()).unwrap();
    assert_eq!(
        check(&state, &fixture, generation, id, b"", b"")
            .err()
            .unwrap(),
        "file_not_found"
    );
    fs::create_dir(fixture.path()).unwrap();
    assert!(check(&state, &fixture, generation, id, b"", b"").is_err());
}

#[test]
fn candidate_limit_is_checked_before_disk_read_and_boundary_is_accepted() {
    let fixture = Fixture::new(b"");
    let (state, generation, id) = fixture.state();
    let candidate = vec![b'x'; MAX_IO_BYTES];
    let observed = check(&state, &fixture, generation, id, b"", &candidate).unwrap();
    assert_eq!(observed.candidate().len(), MAX_IO_BYTES);
    assert_eq!(observed.candidate_hash(), &hash(&candidate));
    drop(observed);
    drop(candidate);
    fs::remove_file(fixture.path()).unwrap();
    let oversized = vec![0; MAX_IO_BYTES + 1];
    assert_eq!(
        check(&state, &fixture, generation, id, b"", &oversized)
            .err()
            .unwrap(),
        "file_too_large"
    );
}

#[test]
fn oversized_disk_is_rejected_without_writing_candidate() {
    let fixture = Fixture::new(b"");
    let (state, generation, id) = fixture.state();
    fs::OpenOptions::new()
        .write(true)
        .open(fixture.path())
        .unwrap()
        .set_len(MAX_IO_BYTES as u64 + 1)
        .unwrap();
    assert_eq!(
        check(&state, &fixture, generation, id, b"", b"new")
            .err()
            .unwrap(),
        "file_too_large"
    );
    assert_eq!(
        fs::metadata(fixture.path()).unwrap().len(),
        MAX_IO_BYTES as u64 + 1
    );
}

#[test]
fn regular_leaf_replacement_reads_current_leaf_and_requires_matching_hash() {
    let fixture = Fixture::new(b"old");
    let (state, generation, id) = fixture.state();
    let replacement = fixture.0.join("replace.tmp");
    fs::write(&replacement, b"replacement").unwrap();
    fs::rename(replacement, fixture.path()).unwrap();
    assert_eq!(
        check(&state, &fixture, generation, id, b"old", b"new")
            .err()
            .unwrap(),
        "stale_disk"
    );
    assert_eq!(
        check(&state, &fixture, generation, id, b"replacement", b"new")
            .unwrap()
            .before(),
        b"replacement"
    );
}

#[test]
fn replaced_leaf_symlink_is_never_followed_even_with_matching_foreign_hash() {
    let fixture = Fixture::new(b"old");
    let (state, generation, id) = fixture.state();
    let foreign = fixture.0.join("foreign.md");
    fs::write(&foreign, b"foreign").unwrap();
    fs::remove_file(fixture.path()).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&foreign, fixture.path()).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&foreign, fixture.path())
        .expect("security tests require symlink privilege / Developer Mode");
    assert!(check(&state, &fixture, generation, id, b"foreign", b"new").is_err());
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign");
}

#[test]
fn retained_parent_never_reopens_replacement_at_selected_display_path() {
    let fixture = Fixture::new(b"unused");
    let live = fixture.0.join("live");
    let held = fixture.0.join("held");
    fs::create_dir(&live).unwrap();
    fs::write(live.join("doc.md"), b"selected").unwrap();
    let (mut state, generation, _) = fixture.state();
    let alias = live.join("doc.md").to_str().unwrap().to_owned();
    let selected = state
        .select(
            "main",
            generation,
            vec![alias.clone().into()],
            Purpose::Document,
        )
        .unwrap();
    let id = GrantId::parse(&selected[0].id).unwrap();
    let renamed = fs::rename(&live, &held);
    #[cfg(windows)]
    if let Err(error) = &renamed {
        // cap-std denies directory deletion sharing on Windows: failure to
        // replace the retained parent is itself the required protection.
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(
            state
                .preflight_document_save("main", generation, &alias, id, hash(b"selected"), b"new")
                .unwrap()
                .before(),
            b"selected"
        );
        return;
    }
    renamed.unwrap();
    fs::create_dir(&live).unwrap();
    fs::write(live.join("doc.md"), b"foreign").unwrap();
    assert_eq!(
        state
            .preflight_document_save("main", generation, &alias, id, hash(b"selected"), b"new")
            .unwrap()
            .before(),
        b"selected"
    );
    assert_eq!(
        state
            .preflight_document_save("main", generation, &alias, id, hash(b"foreign"), b"new")
            .err()
            .unwrap(),
        "stale_disk"
    );
    fs::remove_file(held.join("doc.md")).unwrap();
    assert_eq!(
        state
            .preflight_document_save("main", generation, &alias, id, hash(b"foreign"), b"new")
            .err()
            .unwrap(),
        "file_not_found"
    );
    assert_eq!(fs::read(live.join("doc.md")).unwrap(), b"foreign");
}
