use super::*;
use std::cell::Cell;

#[test]
fn only_complete_bounded_http_urls_reach_dispatch() {
    let mut state = NativeState::default();
    state.register("main").unwrap();
    let generation = state.generation("main").unwrap();
    for input in [
        "https://example.com/a?q=x&y=2#part",
        "HTTP://localhost:8080/",
        "https://[::1]/",
        "https://example.com/日本語",
    ] {
        let calls = Cell::new(0);
        state
            .open_http_link("main", generation, input, |actual| {
                assert_eq!(actual, tauri::Url::parse(input).unwrap().as_str());
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(calls.get(), 1);
    }
    let oversized = format!("https://example.com/{}", "a".repeat(MAX_URL_BYTES));
    for input in [
        "",
        "file:///tmp/a",
        "javascript:alert(1)",
        "mailto:a@example.com",
        "data:text/html,hi",
        "cmd.exe",
        "--help",
        "//example.com",
        "https:example.com",
        "https://",
        "https:///example.com",
        "https://user:pass@example.com",
        "https://user@example.com",
        " https://example.com",
        "https://example.com/\nfile",
        "https://example.com/a b",
        "https://example.com/\0",
        "https://example.com\\file",
        &oversized,
    ] {
        let called = Cell::new(false);
        let error = state
            .open_http_link("main", generation, input, |_| {
                called.set(true);
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error, "invalid_url", "{input:?}");
        assert!(!called.get());
    }
}

#[test]
fn closed_unregistered_preview_and_reused_window_cannot_dispatch() {
    let mut state = NativeState::default();
    state.register("main").unwrap();
    let generation = state.generation("main").unwrap();
    for label in ["print-preview", "preview", "window-forged"] {
        assert_eq!(
            state
                .open_http_link(label, generation, "https://example.com", |_| panic!(
                    "unauthorized launch"
                ))
                .unwrap_err(),
            "permission_required"
        );
    }
    state.revoke("main");
    assert!(state
        .open_http_link("main", generation, "https://example.com", |_| panic!(
            "closed launch"
        ))
        .is_err());
    state.register("main").unwrap();
    assert_eq!(
        state
            .open_http_link("main", generation, "https://example.com", |_| panic!(
                "stale launch"
            ))
            .unwrap_err(),
        "permission_required"
    );
    let current = state.generation("main").unwrap();
    assert_eq!(
        state
            .open_http_link("main", current, "https://example.com", |_| Err(
                io::Error::other("cannot dispatch")
            ))
            .unwrap_err(),
        "open_failed"
    );
}
