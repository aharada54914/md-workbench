use super::*;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("mdw-search-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("work")).unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("outside/secret.md"), b"needle outside").unwrap();
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
    fn write(&self, name: &str, bytes: impl AsRef<[u8]>) {
        fs::write(self.0.join("work").join(name), bytes).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn search(
    state: &NativeState,
    label: &str,
    roots: &[String],
    query: &str,
    limits: SearchLimits,
) -> Result<Vec<ContentSearchHit>, String> {
    state.search_content(label, state.generation(label)?, roots, query, limits)
}
fn normal(state: &NativeState, root: String) -> Result<Vec<ContentSearchHit>, String> {
    search(state, "main", &[root], "needle", SEARCH_LIMITS)
}

#[test]
fn search_rejects_unselected_foreign_and_nonworkspace_authority() {
    let fixture = Fixture::new();
    fixture.write("doc.md", b"needle");
    let state = fixture.state(false);
    assert_eq!(
        normal(&state, fixture.root()).unwrap_err(),
        "permission_required"
    );
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
            normal(&state, fixture.root()).unwrap_err(),
            "permission_required"
        );
    }
    let mut state = fixture.state(false);
    state
        .select(
            "main",
            state.generation("main").unwrap(),
            vec![fixture.0.join("work/doc.md")],
            Purpose::Document,
        )
        .unwrap();
    assert_eq!(
        normal(&state, fixture.root()).unwrap_err(),
        "permission_required"
    );
    let state = fixture.state(true);
    assert_eq!(
        search(
            &state,
            "window-1",
            &[fixture.root()],
            "needle",
            SEARCH_LIMITS
        )
        .unwrap_err(),
        "permission_required"
    );
    assert_eq!(normal(&state, "work".into()).unwrap_err(), "invalid_path");
    assert!(normal(&state, format!("{}/../outside", fixture.root())).is_err());
}

#[test]
fn all_roots_are_authorized_before_any_directory_is_read() {
    let fixture = Fixture::new();
    let state = fixture.state(true);
    // Reading this first selected root would fail due to its vanished subdir.
    // An unowned later root must win before any such filesystem I/O occurs.
    let roots = vec![
        format!("{}/vanished", fixture.root()),
        fixture.0.join("outside").to_str().unwrap().into(),
    ];
    assert_eq!(
        search(&state, "main", &roots, "needle", SEARCH_LIMITS).unwrap_err(),
        "permission_required"
    );
}

#[test]
fn search_preserves_markdown_filters_line_numbers_and_unicode_snippet_dto() {
    let fixture = Fixture::new();
    for name in ["nested", ".hidden", "node_modules"] {
        fs::create_dir(fixture.0.join("work").join(name)).unwrap();
        fixture.write(&format!("{name}/child.md"), b"needle child");
    }
    fixture.write("a.MARKDOWN", "first\r\n  NEEDLE 日本語  \r\nlast");
    fixture.write("b.mdx", format!("needle {}", "界".repeat(300)));
    fixture.write("ignored.txt", b"needle");
    fixture.write("image.png", b"needle");
    fixture.write(".secret.md", b"needle");
    let state = fixture.state(true);
    let hits = search(
        &state,
        "main",
        &[fixture.root()],
        "  nEeDlE  ",
        SEARCH_LIMITS,
    )
    .unwrap();
    assert_eq!(hits.len(), 3);
    let hit = hits
        .iter()
        .find(|hit| hit.path.ends_with("a.MARKDOWN"))
        .unwrap();
    assert_eq!(hit.line, 2);
    assert_eq!(hit.snippet, "NEEDLE 日本語");
    let long = hits.iter().find(|hit| hit.path.ends_with("b.mdx")).unwrap();
    assert_eq!(long.snippet.chars().count(), SNIPPET_CHARS + 1);
    assert!(long.snippet.ends_with('…'));
    let dto = serde_json::to_value(hit).unwrap();
    assert_eq!(dto.as_object().unwrap().len(), 3);
    assert_eq!(dto["line"], 2);
    assert_eq!(dto["snippet"], "NEEDLE 日本語");
    let nested = normal(&state, format!("{}/nested", fixture.root())).unwrap();
    assert_eq!(nested.len(), 1);
}

#[test]
fn oversized_and_non_utf8_files_are_excluded_without_prefix_results() {
    let fixture = Fixture::new();
    fixture.write("exact.md", b"needle");
    fixture.write("large.md", b"needle!");
    fixture.write("invalid.md", [0xff, 0xfe]);
    let state = fixture.state(true);
    let hits = search(
        &state,
        "main",
        &[fixture.root()],
        "needle",
        SearchLimits {
            file_bytes: 6,
            ..SEARCH_LIMITS
        },
    )
    .unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].path.ends_with("exact.md"));
}

#[test]
fn exact_file_and_hit_limits_complete_but_next_match_or_file_rejects_all() {
    let fixture = Fixture::new();
    fixture.write("a.md", b"needle\nneedle");
    let state = fixture.state(true);
    let limits = SearchLimits {
        files: 1,
        hits: 2,
        ..SEARCH_LIMITS
    };
    assert_eq!(
        search(&state, "main", &[fixture.root()], "needle", limits)
            .unwrap()
            .len(),
        2
    );
    fixture.write("a.md", b"needle\nneedle\nneedle");
    assert_eq!(
        search(&state, "main", &[fixture.root()], "needle", limits).unwrap_err(),
        "file_too_large"
    );
    fixture.write("a.md", b"needle\nneedle");
    fixture.write("b.md", b"no match");
    assert_eq!(
        search(&state, "main", &[fixture.root()], "needle", limits).unwrap_err(),
        "file_too_large"
    );
    // The old loop could return > 200 matches from subsequent files in one dir.
    fixture.write("b.md", b"needle");
    assert_eq!(
        search(
            &state,
            "main",
            &[fixture.root()],
            "needle",
            SearchLimits { files: 2, ..limits }
        )
        .unwrap_err(),
        "file_too_large"
    );
}

#[test]
fn bounds_are_shared_across_roots_including_duplicate_roots() {
    let fixture = Fixture::new();
    fixture.write("a.md", b"needle");
    let state = fixture.state(true);
    let roots = [fixture.root(), fixture.root()];
    assert_eq!(
        search(&state, "main", &roots, "needle", SEARCH_LIMITS)
            .unwrap()
            .len(),
        2
    );
    for limits in [
        SearchLimits {
            entries: 1,
            ..SEARCH_LIMITS
        },
        SearchLimits {
            files: 1,
            ..SEARCH_LIMITS
        },
        SearchLimits {
            hits: 1,
            ..SEARCH_LIMITS
        },
    ] {
        assert_eq!(
            search(&state, "main", &roots, "needle", limits).unwrap_err(),
            "file_too_large"
        );
    }
}

#[test]
fn total_entry_budget_counts_hidden_irrelevant_and_nested_entries() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("work/nested")).unwrap();
    for name in ["a.md", ".hidden", "irrelevant.txt", "nested/b.md"] {
        fixture.write(name, b"needle");
    }
    let state = fixture.state(true);
    let limits = SearchLimits {
        entries: 5,
        ..SEARCH_LIMITS
    };
    assert_eq!(
        search(&state, "main", &[fixture.root()], "needle", limits)
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        search(
            &state,
            "main",
            &[fixture.root()],
            "needle",
            SearchLimits {
                entries: 4,
                ..limits
            }
        )
        .unwrap_err(),
        "file_too_large"
    );
}

#[test]
fn depth_limit_allows_files_at_last_directory_level_but_not_another_directory() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("work/nested")).unwrap();
    fixture.write("nested/a.md", b"needle");
    let state = fixture.state(true);
    let limits = SearchLimits {
        depth: 1,
        ..SEARCH_LIMITS
    };
    assert_eq!(
        search(&state, "main", &[fixture.root()], "needle", limits)
            .unwrap()
            .len(),
        1
    );
    fs::create_dir(fixture.0.join("work/nested/empty")).unwrap();
    assert_eq!(
        search(&state, "main", &[fixture.root()], "needle", limits).unwrap_err(),
        "file_too_large"
    );
}

#[test]
fn input_bounds_and_empty_query_do_not_require_filesystem_io() {
    let fixture = Fixture::new();
    let state = fixture.state(false);
    // Empty query does not probe an unselected/missing path.
    assert!(
        search(&state, "main", &[fixture.root()], " \n", SEARCH_LIMITS)
            .unwrap()
            .is_empty()
    );
    let state = fixture.state(true);
    let roots = [fixture.root()];
    let limits = SearchLimits {
        roots: 1,
        root_bytes: roots[0].len(),
        query_bytes: "界".len(),
        ..SEARCH_LIMITS
    };
    assert!(search(&state, "main", &roots, "界", limits)
        .unwrap()
        .is_empty());
    for smaller in [
        SearchLimits { roots: 0, ..limits },
        SearchLimits {
            root_bytes: limits.root_bytes - 1,
            ..limits
        },
        SearchLimits {
            query_bytes: 2,
            ..limits
        },
    ] {
        assert_eq!(
            search(&state, "main", &roots, "界", smaller).unwrap_err(),
            "file_too_large"
        );
    }
}

#[test]
fn expired_budget_rejects_instead_of_returning_an_empty_success() {
    let fixture = Fixture::new();
    let state = fixture.state(true);
    assert_eq!(
        search(
            &state,
            "main",
            &[fixture.root()],
            "needle",
            SearchLimits {
                duration: Duration::ZERO,
                ..SEARCH_LIMITS
            }
        )
        .unwrap_err(),
        "file_too_large"
    );
}

#[test]
fn output_budget_covers_json_escaping_and_rejects_before_partial_return() {
    let fixture = Fixture::new();
    fixture.write("a.md", "needle \u{0000}\"\\");
    let state = fixture.state(true);
    let hit = normal(&state, fixture.root()).unwrap().remove(0);
    let cost = 2 + hit_output_cost(hit.path.len(), hit.snippet.len()).unwrap();
    let limits = SearchLimits {
        output_bytes: cost,
        ..SEARCH_LIMITS
    };
    let hits = search(&state, "main", &[fixture.root()], "needle", limits).unwrap();
    assert!(serde_json::to_vec(&hits).unwrap().len() <= cost);
    assert_eq!(
        search(
            &state,
            "main",
            &[fixture.root()],
            "needle",
            SearchLimits {
                output_bytes: cost - 1,
                ..limits
            }
        )
        .unwrap_err(),
        "file_too_large"
    );
    assert!(hit_output_cost(usize::MAX, 1).is_err());
    assert!(hit_output_cost(usize::MAX / 6, 0).is_err());
}

#[test]
fn stale_window_generation_cannot_search_after_label_reuse() {
    let fixture = Fixture::new();
    let mut state = fixture.state(true);
    let old = state.generation("main").unwrap();
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
            .search_content("main", old, &[fixture.root()], "needle", SEARCH_LIMITS)
            .unwrap_err(),
        "permission_required"
    );
}

#[cfg(unix)]
#[test]
fn retained_workspace_identity_survives_ambient_root_replacement() {
    let fixture = Fixture::new();
    fixture.write("owned.md", b"needle owned");
    let state = fixture.state(true);
    fs::rename(fixture.0.join("work"), fixture.0.join("original")).unwrap();
    std::os::unix::fs::symlink(fixture.0.join("outside"), fixture.0.join("work")).unwrap();
    let hits = normal(&state, fixture.root()).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].snippet, "needle owned");
}

#[cfg(unix)]
#[test]
fn symlinks_are_omitted_and_nested_root_symlink_is_rejected() {
    let fixture = Fixture::new();
    std::os::unix::fs::symlink(fixture.0.join("outside"), fixture.0.join("work/escape")).unwrap();
    std::os::unix::fs::symlink(
        fixture.0.join("outside/secret.md"),
        fixture.0.join("work/escape.md"),
    )
    .unwrap();
    fixture.write("CON.md", b"needle invalid portable name");
    let state = fixture.state(true);
    assert!(normal(&state, fixture.root()).unwrap().is_empty());
    assert!(normal(&state, format!("{}/escape", fixture.root())).is_err());
    assert_eq!(
        search(
            &state,
            "main",
            &[fixture.root()],
            "needle",
            SearchLimits {
                entries: 2,
                ..SEARCH_LIMITS
            }
        )
        .unwrap_err(),
        "file_too_large"
    );
}

#[cfg(windows)]
#[test]
fn windows_junctions_are_omitted_and_native_separator_alias_remains_usable() {
    let fixture = Fixture::new();
    fixture.write("owned.md", b"needle owned");
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(fixture.0.join("work/junction"))
        .arg(fixture.0.join("outside"))
        .output()
        .unwrap();
    assert!(output.status.success(), "junction fixture: {output:?}");
    let state = fixture.state(true);
    let hits = normal(&state, fixture.root().replace('\\', "/")).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].snippet, "needle owned");
    assert!(normal(
        &state,
        format!("{}/junction", fixture.root().replace('\\', "/"))
    )
    .is_err());
}
