use super::*;
use std::fs;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("mdw-path-{}", Uuid::new_v4()));
        fs::create_dir_all(path.join("work/nested")).unwrap();
        fs::write(path.join("work/doc.md"), b"\xef\xbb\xbf# Raw\r\n").unwrap();
        fs::write(path.join("work/nested/child.md"), b"child").unwrap();
        fs::write(path.join("outside.md"), b"outside").unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn path(&self, relative: &str) -> String {
        self.0.join(relative).to_str().unwrap().into()
    }
    fn state(&self) -> NativeState {
        let mut state = NativeState::default();
        state.register("main").unwrap();
        state.register("window-1").unwrap();
        state
    }
    fn grant(&self, state: &mut NativeState, relative: &str, purpose: Purpose) {
        state
            .select(
                "main",
                state.generation("main").unwrap(),
                vec![self.path(relative).into()],
                purpose,
            )
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn read(state: &NativeState, label: &str, path: &str, limit: usize) -> Result<Vec<u8>, String> {
    state.read_path(label, state.generation(label)?, path, limit)
}
fn list(
    state: &NativeState,
    label: &str,
    path: &str,
    limit: usize,
) -> Result<NativeDirectoryListing, String> {
    state.list_path(label, state.generation(label)?, path, limit)
}
#[test]
fn paths_never_create_authority_or_borrow_another_windows_grant() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    assert_eq!(
        read(&state, "main", &fixture.path("work/doc.md"), 100).unwrap_err(),
        "permission_required"
    );
    fixture.grant(&mut state, "work/doc.md", Purpose::Document);
    assert_eq!(
        read(&state, "main", &fixture.path("work/doc.md"), 100).unwrap(),
        b"\xef\xbb\xbf# Raw\r\n"
    );
    assert_eq!(
        read(&state, "window-1", &fixture.path("work/doc.md"), 100).unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        read(&state, "main", &fixture.path("outside.md"), 100).unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        list(&state, "main", &fixture.path("work"), 100).unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        read(&state, "main", "relative.md", 100).unwrap_err(),
        "invalid_path"
    );
}
#[test]
fn exact_and_workspace_native_aliases_resolve_without_disk_canonicalization() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let alias = fixture.0.join("work").join(".").join("doc.md");
    state
        .select(
            "main",
            state.generation("main").unwrap(),
            vec![alias.clone()],
            Purpose::Resource,
        )
        .unwrap();
    for path in [
        alias.to_str().unwrap(),
        fixture.path("work/doc.md").as_str(),
    ] {
        assert_eq!(
            read(&state, "main", path, 100).unwrap(),
            b"\xef\xbb\xbf# Raw\r\n"
        );
    }
    let workspace_alias = fixture.0.join(".").join("work");
    state
        .select(
            "main",
            state.generation("main").unwrap(),
            vec![workspace_alias.clone()],
            Purpose::Workspace,
        )
        .unwrap();
    assert_eq!(
        read(
            &state,
            "main",
            workspace_alias.join("nested/child.md").to_str().unwrap(),
            100
        )
        .unwrap(),
        b"child"
    );
    assert_eq!(
        list(&state, "main", workspace_alias.to_str().unwrap(), 100)
            .unwrap()
            .entries
            .len(),
        2
    );
    assert_eq!(
        list(&state, "main", &fixture.path("work"), 100)
            .unwrap()
            .entries
            .len(),
        2
    );
}
#[test]
fn list_is_bounded_direct_children_and_dto_uses_camel_case() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    fixture.grant(&mut state, "work", Purpose::Workspace);
    let listing = list(&state, "main", &fixture.path("work"), 2).unwrap();
    assert_eq!(listing.entries[0].name, "nested");
    assert!(listing.entries[0].is_directory);
    assert_eq!(listing.entries[1].name, "doc.md");
    assert!(!listing.entries[1].is_directory);
    assert_eq!(listing.omitted, 0);
    assert_eq!(
        list(&state, "main", &fixture.path("work/nested"), 1)
            .unwrap()
            .entries[0]
            .name,
        "child.md"
    );
    let json = serde_json::to_value(listing).unwrap();
    assert_eq!(json["entries"][0]["isDirectory"], true);
    assert!(json["entries"][0].get("is_directory").is_none());
    assert_eq!(
        list(&state, "main", &fixture.path("work"), 1).unwrap_err(),
        "file_too_large"
    );
    assert_eq!(
        list(&state, "main", &fixture.path("work"), 10001).unwrap_err(),
        "file_too_large"
    );
    assert_eq!(
        read(&state, "main", &fixture.path("work/doc.md"), 1).unwrap_err(),
        "file_too_large"
    );
    assert_eq!(
        read(&state, "main", &fixture.path("work/doc.md"), 67108865).unwrap_err(),
        "file_too_large"
    );
}
#[test]
fn workspace_prefix_is_a_boundary_and_unsafe_relative_paths_are_not_normalized() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    fixture.grant(&mut state, "work", Purpose::Workspace);
    for suffix in [
        "../outside.md",
        "./doc.md",
        "nested/../doc.md",
        "/doc.md",
        "CON.md",
        "x:ads",
        "x\\doc.md",
        "doc.md.",
    ] {
        let path = format!("{}/{}", fixture.path("work"), suffix);
        assert!(read(&state, "main", &path, 100).is_err(), "allowed {path}");
        assert!(list(&state, "main", &path, 100).is_err(), "listed {path}");
    }
    assert_eq!(
        read(&state, "main", &fixture.path("work-other/doc.md"), 100).unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        list(&state, "window-1", &fixture.path("work"), 100).unwrap_err(),
        "permission_required"
    );
}
#[test]
fn exact_read_is_preferred_to_workspace_and_most_specific_workspace_wins() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    fixture.grant(&mut state, "work", Purpose::Workspace);
    fixture.grant(&mut state, "work/nested", Purpose::Workspace);
    fixture.grant(&mut state, "work/doc.md", Purpose::Resource);
    let exact = state
        .lookup("main", &fixture.path("work/doc.md"))
        .unwrap()
        .unwrap();
    let resolved = state
        .resolve_owned_path("main", &fixture.path("work/doc.md"), false)
        .unwrap();
    assert_eq!(resolved.0.to_string(), exact.id);
    assert!(resolved.1.is_empty());
    let nested = state
        .lookup("main", &fixture.path("work/nested"))
        .unwrap()
        .unwrap();
    let resolved = state
        .resolve_owned_path("main", &fixture.path("work/nested/child.md"), false)
        .unwrap();
    assert_eq!(resolved.0.to_string(), nested.id);
    assert_eq!(resolved.1, "child.md");
    assert!(read(&state, "main", &fixture.path("work"), 100).is_err());
}
#[test]
fn destruction_and_reused_label_deny_a_previously_scheduled_read_or_list() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    fixture.grant(&mut state, "work", Purpose::Workspace);
    let generation = state.generation("main").unwrap();
    state.revoke("main");
    state.register("main").unwrap();
    fixture.grant(&mut state, "work", Purpose::Workspace);
    assert_eq!(
        state
            .read_path("main", generation, &fixture.path("work/doc.md"), 100)
            .unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        state
            .list_path("main", generation, &fixture.path("work"), 100)
            .unwrap_err(),
        "permission_required"
    );
}
#[test]
fn write_only_latest_metadata_is_not_upgraded_from_a_hidden_older_read_grant() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    fixture.grant(&mut state, "work/doc.md", Purpose::Document);
    let old = state
        .lookup("main", &fixture.path("work/doc.md"))
        .unwrap()
        .unwrap();
    fixture.grant(&mut state, "work/doc.md", Purpose::Save);
    assert_eq!(
        read(&state, "main", &fixture.path("work/doc.md"), 100).unwrap_err(),
        "permission_required"
    );
    // The prior UUID still exists; path lookup deliberately does not search hidden
    // grant history. Purpose-specific save lookup is a separate migration step.
    assert!(state
        .access
        .read("main", GrantId::parse(&old.id).unwrap(), Path::new(""), 100)
        .is_ok());
}
#[cfg(unix)]
#[test]
fn read_and_list_follow_pinned_workspaces_after_parent_replacement() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    fixture.grant(&mut state, "work", Purpose::Workspace);
    fixture.grant(&mut state, "work/nested", Purpose::Workspace);
    let moved = fixture.0.join("moved");
    fs::rename(fixture.0.join("work/nested"), &moved).unwrap();
    fs::create_dir(fixture.0.join("work/nested")).unwrap();
    fs::write(fixture.0.join("work/nested/child.md"), b"replacement").unwrap();
    fs::write(fixture.0.join("work/nested/other.md"), b"new").unwrap();
    assert_eq!(
        read(&state, "main", &fixture.path("work/nested/child.md"), 100).unwrap(),
        b"child"
    );
    assert_eq!(
        list(&state, "main", &fixture.path("work/nested"), 100)
            .unwrap()
            .entries
            .len(),
        1
    );
}
#[cfg(any(unix, windows))]
#[test]
fn path_read_and_listing_reject_symlink_children_and_surface_omissions() {
    let fixture = Fixture::new();
    #[cfg(unix)]
    std::os::unix::fs::symlink(fixture.0.join("work/nested"), fixture.0.join("work/link")).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(fixture.0.join("work/nested"), fixture.0.join("work/link"))
        .expect("Windows native tests require Developer Mode or elevation");
    let mut state = fixture.state();
    fixture.grant(&mut state, "work", Purpose::Workspace);
    assert!(read(&state, "main", &fixture.path("work/link/child.md"), 100).is_err());
    assert!(list(&state, "main", &fixture.path("work/link"), 100).is_err());
    let listing = list(&state, "main", &fixture.path("work"), 3).unwrap();
    assert_eq!(listing.omitted, 1);
    assert_eq!(listing.entries.len(), 2);
}
#[test]
fn relative_prefix_keeps_unsafe_components_for_core_rejection() {
    assert_eq!(
        relative_to("/w/nested/doc.md", "/w"),
        Some("nested/doc.md".into())
    );
    assert_eq!(relative_to("/w/../secret", "/w"), Some("../secret".into()));
    assert_eq!(relative_to("/w//doc", "/w"), Some("/doc".into()));
    assert_eq!(relative_to("/wrong/doc", "/w"), None);
    assert_eq!(relative_to("/", "/"), Some("".into()));
    assert_eq!(relative_to("/doc", "/"), Some("doc".into()));
}

#[cfg(windows)]
#[test]
fn windows_native_and_frontend_separator_spellings_use_the_same_owned_authority() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    fixture.grant(&mut state, "work", Purpose::Workspace);
    fixture.grant(&mut state, "work/doc.md", Purpose::Document);
    let document = fixture.path("work/doc.md").replace('\\', "/");
    let workspace = fixture.path("work").replace('\\', "/");
    assert_eq!(
        read(&state, "main", &document, 100).unwrap(),
        b"\xef\xbb\xbf# Raw\r\n"
    );
    assert_eq!(
        list(&state, "main", &workspace, 100).unwrap().entries.len(),
        2
    );
    assert!(read(&state, "main", r"C:relative.md", 100).is_err());
    assert!(read(&state, "main", r"\\unselected\share\doc.md", 100).is_err());
}

#[cfg(any(unix, windows))]
#[test]
fn equivalent_workspace_aliases_prefer_the_requested_spelling_and_retained_root() {
    let fixture = Fixture::new();
    let mut state = fixture.state();
    let generation = state.generation("main").unwrap();
    let link = fixture.0.join("selected");
    for (name, bytes) in [("first", b"first"), ("later", b"later")] {
        fs::create_dir(fixture.0.join(name)).unwrap();
        fs::write(fixture.0.join(name).join("doc.md"), bytes).unwrap();
        fs::write(fixture.0.join(name).join(name), bytes).unwrap();
    }
    #[cfg(unix)]
    let (first_alias, later_alias) = (format!("{}/", link.display()), link.display().to_string());
    #[cfg(windows)]
    let (first_alias, later_alias) = {
        // Native dialogs return ordinary DOS paths; canonical fixture paths carry
        // a verbatim prefix whose slash conversion is not a native selection path.
        let plain = link.to_str().unwrap().strip_prefix(r"\\?\").unwrap();
        (plain.to_owned(), plain.replace('\\', "/"))
    };
    #[cfg(unix)]
    std::os::unix::fs::symlink(fixture.0.join("first"), &link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(fixture.0.join("first"), &link)
        .expect("Windows native tests require Developer Mode or elevation");
    state
        .select(
            "main",
            generation,
            vec![first_alias.clone().into()],
            Purpose::Workspace,
        )
        .unwrap();
    #[cfg(unix)]
    fs::remove_file(&link).unwrap();
    #[cfg(windows)]
    fs::remove_dir(&link).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(fixture.0.join("later"), &link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(fixture.0.join("later"), &link).unwrap();
    state
        .select(
            "main",
            generation,
            vec![later_alias.clone().into()],
            Purpose::Workspace,
        )
        .unwrap();
    for (alias, expected) in [(&first_alias, "first"), (&later_alias, "later")] {
        let listing = list(&state, "main", alias, 10).unwrap();
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["doc.md", expected]
        );
        #[cfg(windows)]
        {
            let separator = if alias.contains('\\') { '\\' } else { '/' };
            assert_eq!(
                read(&state, "main", &format!("{alias}{separator}doc.md"), 100).unwrap(),
                expected.as_bytes()
            );
        }
    }
    assert_eq!(
        read(&state, "main", &fixture.path("first/doc.md"), 100).unwrap(),
        b"first"
    );
    assert_eq!(
        read(&state, "main", &fixture.path("later/doc.md"), 100).unwrap(),
        b"later"
    );
}
