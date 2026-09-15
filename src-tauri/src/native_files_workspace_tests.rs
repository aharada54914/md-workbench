use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-tree-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("work")).unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("outside/secret.md"), b"outside").unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
    fn root(&self) -> String {
        self.0.join("work").to_str().unwrap().into()
    }
    fn state(&self, selected: bool) -> NativeState {
        let mut state = NativeState::default();
        state.register("main").unwrap();
        state.register("window-1").unwrap();
        if selected {
            state
                .select(
                    "main",
                    state.generation("main").unwrap(),
                    vec![self.root().into()],
                    Purpose::Workspace,
                )
                .unwrap();
        }
        state
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn tree(state: &NativeState, label: &str, root: &str) -> Result<WorkspaceNode, String> {
    state.workspace_tree(
        label,
        state.generation(label)?,
        root,
        WORKSPACE_TREE_MAX_DEPTH,
        WORKSPACE_TREE_MAX_ENTRIES,
        WORKSPACE_TREE_MAX_OUTPUT_BYTES,
    )
}
fn names(node: &WorkspaceNode) -> Vec<&str> {
    node.children
        .as_ref()
        .unwrap()
        .iter()
        .map(|child| child.name.as_str())
        .collect()
}

#[test]
fn persisted_or_foreign_paths_never_authorize_a_tree() {
    let fixture = Fixture::new();
    let mut state = fixture.state(false);
    assert_eq!(
        tree(&state, "main", &fixture.root()).unwrap_err(),
        "permission_required"
    );
    fs::write(fixture.0.join("work/exact.md"), b"doc").unwrap();
    state
        .select(
            "main",
            state.generation("main").unwrap(),
            vec![fixture.0.join("work/exact.md")],
            Purpose::Document,
        )
        .unwrap();
    assert_eq!(
        tree(&state, "main", &fixture.root()).unwrap_err(),
        "permission_required"
    );
    let state = fixture.state(true);
    assert_eq!(
        tree(&state, "window-1", &fixture.root()).unwrap_err(),
        "permission_required"
    );
    assert_eq!(
        tree(&state, "main", fixture.0.join("outside").to_str().unwrap()).unwrap_err(),
        "permission_required"
    );
    assert_eq!(tree(&state, "main", "work").unwrap_err(), "invalid_path");
    assert!(tree(&state, "main", &format!("{}/../outside", fixture.root())).is_err());
}

#[test]
fn tree_preserves_filters_case_order_dto_and_handle_metadata_mtime() {
    let fixture = Fixture::new();
    for name in ["zFolder", "AFolder", ".hidden", "node_modules"] {
        fs::create_dir(fixture.0.join("work").join(name)).unwrap();
        fs::write(fixture.0.join("work").join(name).join("child.md"), b"child").unwrap();
    }
    for name in [
        "z.md",
        "B.MARKDOWN",
        "a.MDX",
        "image.PNG",
        "vector.svg",
        "ignore.txt",
        ".secret.md",
    ] {
        fs::write(fixture.0.join("work").join(name), b"file").unwrap();
    }
    let mtime = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
    fs::File::options()
        .write(true)
        .open(fixture.0.join("work/z.md"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(mtime))
        .unwrap();
    let state = fixture.state(true);
    let result = tree(&state, "main", &fixture.root()).unwrap();
    assert_eq!(
        names(&result),
        vec![
            "AFolder",
            "zFolder",
            "a.MDX",
            "B.MARKDOWN",
            "image.PNG",
            "vector.svg",
            "z.md"
        ]
    );
    assert!(result.modified > 0);
    let children = result.children.as_ref().unwrap();
    assert_eq!(names(&children[0]), vec!["child.md"]);
    assert_eq!(children.last().unwrap().modified, 1_600_000_000_000);
    let dto = serde_json::to_value(&result).unwrap();
    assert_eq!(dto["kind"], "folder");
    assert_eq!(dto["path"], fixture.root());
    assert_eq!(dto["children"][6]["children"], serde_json::Value::Null);
    assert_eq!(dto["children"][6]["kind"], "file");
    assert_eq!(dto["children"][6]["modified"], 1_600_000_000_000_u64);
}

#[test]
fn total_scan_budget_counts_filtered_entries_across_directories() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("work/nested")).unwrap();
    for name in ["doc.md", ".hidden", "ignored.txt", "nested/child.md"] {
        fs::write(fixture.0.join("work").join(name), b"file").unwrap();
    }
    let state = fixture.state(true);
    let generation = state.generation("main").unwrap();
    assert_eq!(
        state
            .workspace_tree(
                "main",
                generation,
                &fixture.root(),
                50,
                4,
                WORKSPACE_TREE_MAX_OUTPUT_BYTES
            )
            .unwrap_err(),
        "file_too_large"
    );
    let complete = state
        .workspace_tree(
            "main",
            generation,
            &fixture.root(),
            50,
            5,
            WORKSPACE_TREE_MAX_OUTPUT_BYTES,
        )
        .unwrap();
    assert_eq!(names(&complete), vec!["nested", "doc.md"]);
    assert_eq!(
        names(&complete.children.as_ref().unwrap()[0]),
        vec!["child.md"]
    );
}

#[test]
fn directory_depth_limit_rejects_instead_of_silently_truncating() {
    let fixture = Fixture::new();
    let mut nested = fixture.0.join("work");
    for _ in 0..=WORKSPACE_TREE_MAX_DEPTH {
        nested = nested.join("d");
        fs::create_dir(&nested).unwrap();
    }
    fs::write(nested.join("deep.md"), b"deep").unwrap();
    let state = fixture.state(true);
    assert_eq!(
        tree(&state, "main", &fixture.root()).unwrap_err(),
        "file_too_large"
    );
    let complete = state
        .workspace_tree(
            "main",
            state.generation("main").unwrap(),
            &fixture.root(),
            WORKSPACE_TREE_MAX_DEPTH + 1,
            100,
            WORKSPACE_TREE_MAX_OUTPUT_BYTES,
        )
        .unwrap();
    let mut leaf = &complete;
    for _ in 0..=WORKSPACE_TREE_MAX_DEPTH {
        leaf = &leaf.children.as_ref().unwrap()[0];
    }
    assert_eq!(names(leaf), vec!["deep.md"]);
}

#[test]
fn queued_tree_denies_destroyed_and_reused_window_generations() {
    let fixture = Fixture::new();
    let mut state = fixture.state(true);
    let old_generation = state.generation("main").unwrap();
    state.revoke("main");
    state.register("main").unwrap();
    state
        .select(
            "main",
            state.generation("main").unwrap(),
            vec![fixture.root().into()],
            Purpose::Workspace,
        )
        .unwrap();
    assert_eq!(
        state
            .workspace_tree(
                "main",
                old_generation,
                &fixture.root(),
                50,
                100,
                WORKSPACE_TREE_MAX_OUTPUT_BYTES
            )
            .unwrap_err(),
        "permission_required"
    );
}

#[cfg(unix)]
#[test]
fn retained_tree_does_not_follow_replaced_workspace_paths() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("work/nested")).unwrap();
    fs::write(fixture.0.join("work/nested/original.md"), b"original").unwrap();
    let state = fixture.state(true);
    fs::rename(fixture.0.join("work"), fixture.0.join("original")).unwrap();
    std::os::unix::fs::symlink(fixture.0.join("outside"), fixture.0.join("work")).unwrap();
    let result = tree(&state, "main", &fixture.root()).unwrap();
    assert_eq!(names(&result), vec!["nested"]);
    assert_eq!(
        names(&result.children.as_ref().unwrap()[0]),
        vec!["original.md"]
    );
}

#[cfg(unix)]
#[test]
fn symlinks_and_unsafe_names_are_omitted_but_count_toward_budget() {
    let fixture = Fixture::new();
    std::os::unix::fs::symlink(fixture.0.join("outside"), fixture.0.join("work/escape")).unwrap();
    std::os::unix::fs::symlink(
        fixture.0.join("outside/secret.md"),
        fixture.0.join("work/escape.md"),
    )
    .unwrap();
    fs::write(fixture.0.join("work/CON.md"), b"device alias").unwrap();
    let state = fixture.state(true);
    assert!(names(&tree(&state, "main", &fixture.root()).unwrap()).is_empty());
    assert_eq!(
        state
            .workspace_tree(
                "main",
                state.generation("main").unwrap(),
                &fixture.root(),
                50,
                2,
                WORKSPACE_TREE_MAX_OUTPUT_BYTES
            )
            .unwrap_err(),
        "file_too_large"
    );
}

#[cfg(windows)]
#[test]
fn windows_tree_omits_junctions_and_accepts_existing_separator_alias() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("work/owned.md"), b"owned").unwrap();
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(fixture.0.join("work/junction"))
        .arg(fixture.0.join("outside"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native junction fixture: {output:?}"
    );
    let state = fixture.state(true);
    let result = tree(&state, "main", &fixture.root().replace('\\', "/")).unwrap();
    assert_eq!(names(&result), vec!["owned.md"]);
    assert_eq!(
        state
            .workspace_tree(
                "main",
                state.generation("main").unwrap(),
                &fixture.root(),
                50,
                1,
                WORKSPACE_TREE_MAX_OUTPUT_BYTES
            )
            .unwrap_err(),
        "file_too_large"
    );
}

#[test]
fn workspace_tree_requires_readable_workspace_kind_and_allows_selected_hidden_root() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join(".chosen")).unwrap();
    fs::write(fixture.0.join(".chosen/visible.md"), b"visible").unwrap();
    for (kind, rights) in [
        (GrantKind::Workspace, Rights::WRITE),
        (GrantKind::Resource, Rights::READ),
    ] {
        let mut state = fixture.state(false);
        let info = state
            .access
            .grant_directory_from_native_selection("main", Path::new(&fixture.root()), kind, rights)
            .unwrap();
        state.remember("main", Path::new(&fixture.root()), info);
        assert_eq!(
            tree(&state, "main", &fixture.root()).unwrap_err(),
            "permission_required"
        );
    }
    let mut state = fixture.state(false);
    let hidden = fixture.0.join(".chosen");
    state
        .select(
            "main",
            state.generation("main").unwrap(),
            vec![hidden.clone()],
            Purpose::Workspace,
        )
        .unwrap();
    assert_eq!(
        names(&tree(&state, "main", hidden.to_str().unwrap()).unwrap()),
        vec!["visible.md"]
    );
}

#[test]
fn output_budget_includes_root_and_each_document_before_returning_a_tree() {
    let fixture = Fixture::new();
    let state = fixture.state(true);
    let generation = state.generation("main").unwrap();
    let root = fixture.root();
    let root_name = Path::new(&root).file_name().unwrap().to_str().unwrap();
    let root_cost = node_output_cost(root_name.len(), root.len()).unwrap();
    let empty = state
        .workspace_tree("main", generation, &root, 50, 100, root_cost)
        .unwrap();
    assert!(names(&empty).is_empty());
    assert!(serde_json::to_vec(&empty).unwrap().len() <= root_cost);
    assert_eq!(
        state
            .workspace_tree("main", generation, &root, 50, 100, root_cost - 1)
            .unwrap_err(),
        "file_too_large"
    );

    let filename = "日本語.md";
    let file = fixture.0.join("work").join(filename);
    fs::write(&file, b"contents").unwrap();
    let file_cost = node_output_cost(filename.len(), file.to_str().unwrap().len()).unwrap();
    let total = root_cost + file_cost;
    let complete = state
        .workspace_tree("main", generation, &root, 50, 100, total)
        .unwrap();
    assert_eq!(names(&complete), vec![filename]);
    assert!(serde_json::to_vec(&complete).unwrap().len() <= total);
    for insufficient in [0, root_cost, total - 1] {
        assert_eq!(
            state
                .workspace_tree("main", generation, &root, 50, 100, insufficient)
                .unwrap_err(),
            "file_too_large"
        );
    }
}

#[test]
fn output_estimate_checks_overflow_and_bounds_worst_case_json_escaping() {
    for lengths in [(usize::MAX, 1), (0, usize::MAX), (usize::MAX / 6, 0)] {
        assert_eq!(
            node_output_cost(lengths.0, lengths.1).unwrap_err(),
            "file_too_large"
        );
    }
    let node = WorkspaceNode {
        name: "\u{0000}\"\\".into(),
        path: "\u{0000}\n\t".into(),
        kind: "folder",
        children: Some(Vec::new()),
        modified: u64::MAX,
    };
    assert!(
        serde_json::to_vec(&node).unwrap().len()
            <= node_output_cost(node.name.len(), node.path.len()).unwrap()
    );
}
