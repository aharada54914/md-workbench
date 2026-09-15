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
fn editor_navigation_uses_host_configuration_and_encodes_filename_once() {
    let mut config = tauri::utils::config::Config::default();
    config.build.dev_url = Some(tauri::Url::parse("http://localhost:1420/").unwrap());
    let path = "/日本語/a%20 # &?.md";
    let url = editor_url(&config, true, false, Some(path)).unwrap();
    assert_eq!(url.origin().ascii_serialization(), "http://localhost:1420");
    assert_eq!(url.path(), "/index.html");
    assert_eq!(
        url.query_pairs().find(|(key, _)| key == "file").unwrap().1,
        path
    );
    assert_eq!(
        editor_url(&config, false, false, None).unwrap().as_str(),
        "tauri://localhost"
    );
    assert_eq!(
        editor_url(&config, false, true, None).unwrap().as_str(),
        "http://tauri.localhost/"
    );
    config.build.frontend_dist = Some(tauri::utils::config::FrontendDist::Url(
        tauri::Url::parse("https://app.example.test/base/").unwrap(),
    ));
    assert_eq!(
        editor_url(&config, false, false, Some(path))
            .unwrap()
            .origin()
            .ascii_serialization(),
        "https://app.example.test"
    );
}
