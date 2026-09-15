use super::*;

#[test]
fn metadata_removal_cannot_remove_another_callers_registration() {
    let registry = OpenFilesRegistry::default();
    registry.register("shared.md", "main");
    registry.register("shared.md", "window-1");
    registry.register("only-main.md", "main");
    registry.remove_file("only-main.md", "window-1");
    assert_eq!(
        registry
            .owner("only-main.md", "window-1", |_| true)
            .as_deref(),
        Some("main")
    );
    assert_eq!(
        registry.owner("shared.md", "window-1", |_| true).as_deref(),
        Some("window-1")
    );
    registry.remove_window("window-1");
    registry.remove_window("window-1");
    assert_eq!(
        registry.owner("shared.md", "window-1", |_| true).as_deref(),
        Some("main")
    );
    assert_eq!(
        registry
            .owner("only-main.md", "window-1", |_| true)
            .as_deref(),
        Some("main")
    );
}
#[test]
fn registry_prefers_actual_caller_and_ignores_nonlive_owners() {
    let registry = OpenFilesRegistry::default();
    for owner in ["main", "window-10", "window-2"] {
        registry.register("doc.md", owner);
    }
    assert_eq!(
        registry.owner("doc.md", "window-10", |_| true).as_deref(),
        Some("window-10")
    );
    assert_eq!(
        registry
            .owner("doc.md", "window-3", |label| label != "main")
            .as_deref(),
        Some("window-2")
    );
    assert!(registry.owner("doc.md", "main", |_| false).is_none());
}
#[test]
fn failed_transfer_registration_rollback_preserves_existing_target() {
    let registry = OpenFilesRegistry::default();
    assert!(registry.register("doc.md", "window-1"));
    let added = registry.register("doc.md", "window-1");
    assert!(!added);
    if added {
        registry.remove_file("doc.md", "window-1");
    }
    assert_eq!(
        registry.owner("doc.md", "window-1", |_| true).as_deref(),
        Some("window-1")
    );
}
#[test]
fn editor_navigation_uses_host_configuration_without_a_second_file_route() {
    let mut config = tauri::utils::config::Config::default();
    config.build.dev_url = Some(tauri::Url::parse("http://localhost:1420/").unwrap());
    let url = editor_url(&config, true, false).unwrap();
    assert_eq!(url.origin().ascii_serialization(), "http://localhost:1420");
    assert_eq!(url.path(), "/");
    assert!(url.query().is_none());
    assert_eq!(
        editor_url(&config, false, false).unwrap().as_str(),
        "tauri://localhost"
    );
    assert_eq!(
        editor_url(&config, false, true).unwrap().as_str(),
        "http://tauri.localhost/"
    );
    config.build.frontend_dist = Some(tauri::utils::config::FrontendDist::Url(
        tauri::Url::parse("https://app.example.test/base/").unwrap(),
    ));
    assert_eq!(
        editor_url(&config, false, false)
            .unwrap()
            .origin()
            .ascii_serialization(),
        "https://app.example.test"
    );
}

#[test]
fn transfer_nonce_cleanup_never_removes_other_transfer_or_normal_registration() {
    let registry = OpenFilesRegistry::default();
    let first = native_files::PendingTabTransfer {
        id: "first".into(),
        file_path: "doc.md".into(),
        source_window: "main".into(),
        target_window: "window-1".into(),
    };
    let second = native_files::PendingTabTransfer {
        id: "second".into(),
        ..first.clone()
    };
    registry.add_transfer(&first);
    registry.add_transfer(&second);
    registry.register("doc.md", "main");
    registry.remove_transfer("first");
    assert_eq!(
        registry.owner("doc.md", "window-1", |_| true).as_deref(),
        Some("window-1")
    );
    registry.register("doc.md", "window-1");
    registry.remove_transfer("second");
    assert_eq!(
        registry.owner("doc.md", "window-1", |_| true).as_deref(),
        Some("window-1")
    );
    registry.add_transfer(&first);
    registry.remove_file("doc.md", "window-1");
    assert_eq!(
        registry.owner("doc.md", "window-1", |_| true).as_deref(),
        Some("window-1")
    );
    registry.remove_window("window-1");
    assert_eq!(
        registry.owner("doc.md", "window-1", |_| true).as_deref(),
        Some("main")
    );
    assert!(registry.0.lock().unwrap().transfers.is_empty());
}
