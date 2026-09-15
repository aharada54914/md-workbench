//! Opt-in, fixed synthetic boundary experiment. Never registers editor authority.
use std::sync::{Arc, Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const HOST: &str = "mdwdiagramhost";
const CHILD: &str = "mdwdiagramfixture";
const FOREIGN: &str = "mdwdiagramforeign";
const LABEL_PREFIX: &str = "diagram-spike-";
#[derive(Default)]
struct Session {
    label: String,
    nonce: String,
    live: bool,
    served_host: bool,
    served_child: bool,
    started: Option<std::time::Instant>,
    frame_probe: bool,
    served_foreign: bool,
}
type Shared = Arc<Mutex<Session>>;

// UUID v4 has fixed version/variant bits. Select only random hex positions
// across two independent UUIDs to retain a full 128 unpredictable bits.
fn nonce() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{}{}{}", &a[..12], &a[20..], &b[..8])
}
fn origin(scheme: &str) -> String {
    if cfg!(any(target_os = "windows", target_os = "android")) {
        format!("http://{scheme}.localhost")
    } else {
        format!("{scheme}://localhost")
    }
}
fn policy(child: bool) -> String {
    format!("default-src 'none'; script-src 'self'; connect-src 'none'; frame-src {}; object-src 'none'; base-uri 'none'; form-action 'none'; img-src 'none'; font-src 'none'; worker-src 'none'", if child { "'none'".into() } else { origin(CHILD) })
}
fn asset(scheme: &str, path: &str) -> Option<(&'static str, &'static str)> {
    match (scheme, path) {
        (HOST, "/") => Some((include_str!("diagram_spike/host.html"), "text/html")),
        (CHILD, "/") => Some((include_str!("diagram_spike/child.html"), "text/html")),
        (HOST, "/host.mjs") => Some((include_str!("diagram_spike/host.mjs"), "text/javascript")),
        (CHILD, "/child.mjs") => Some((include_str!("diagram_spike/child.mjs"), "text/javascript")),
        (HOST | CHILD, "/protocol.mjs") => Some((
            include_str!("diagram_spike/protocol.mjs"),
            "text/javascript",
        )),
        _ => None,
    }
}
fn probe_asset(scheme: &str, path: &str) -> Option<(&'static str, &'static str)> {
    match (scheme, path) {
        (FOREIGN, "/") | (CHILD, "/sibling.html") => {
            Some((include_str!("diagram_spike/peer.html"), "text/html"))
        }
        (FOREIGN | CHILD, "/peer.mjs") => {
            Some((include_str!("diagram_spike/peer.mjs"), "text/javascript"))
        }
        _ => None,
    }
}
fn reply(
    state: &Shared,
    label: &str,
    scheme: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let mut session = state.lock().unwrap();
    let route = asset(scheme, request.uri().path()).or_else(|| {
        session
            .frame_probe
            .then(|| probe_asset(scheme, request.uri().path()))
            .flatten()
    });
    if session
        .started
        .is_some_and(|started| started.elapsed() >= std::time::Duration::from_secs(10))
    {
        session.live = false;
    }
    // URI is supplied by the engine's registered scheme handler. No decoded path,
    // query, ambient path, or renderer-provided owner can select an asset.
    let allowed = session.live
        && session.label == label
        && request.method() == "GET"
        && request.uri().query().is_none()
        && route.is_some()
        && (request.uri().host() == Some("localhost")
            || request.uri().host() == Some(format!("{scheme}.localhost").as_str()));
    if !allowed {
        return tauri::http::Response::builder()
            .status(403)
            .body(Vec::new())
            .unwrap();
    }
    if scheme == HOST && request.uri().path() == "/" {
        if session.served_host {
            session.live = false;
            return tauri::http::Response::builder()
                .status(410)
                .body(Vec::new())
                .unwrap();
        }
        session.served_host = true;
    }
    if scheme == CHILD && request.uri().path() == "/" {
        if session.served_child {
            session.live = false;
            return tauri::http::Response::builder()
                .status(410)
                .body(Vec::new())
                .unwrap();
        }
        session.served_child = true;
    }
    if scheme == FOREIGN && request.uri().path() == "/" {
        if session.served_foreign {
            session.live = false;
            return tauri::http::Response::builder()
                .status(410)
                .body(Vec::new())
                .unwrap();
        }
        session.served_foreign = true;
    }
    let (body, mime) = route.unwrap();
    // Only native random hex and compile-time origins enter these fixed HTML files.
    let body = body
        .replace("__NONCE__", &session.nonce)
        .replace("__HOST_ORIGIN__", &origin(HOST))
        .replace("__CHILD_ORIGIN__", &origin(CHILD))
        .replace("__FOREIGN_ORIGIN__", &origin(FOREIGN))
        .replace(
            "__FRAME_PROBE__",
            if session.frame_probe { "true" } else { "false" },
        );
    let csp = if scheme == HOST && session.frame_probe {
        policy(false).replace(
            &format!("frame-src {}", origin(CHILD)),
            &format!("frame-src {} {}", origin(CHILD), origin(FOREIGN)),
        )
    } else {
        policy(scheme != HOST)
    };
    tauri::http::Response::builder()
        .header("Content-Type", format!("{mime}; charset=utf-8"))
        .header("Content-Security-Policy", csp)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(body.into_bytes())
        .unwrap()
}
pub(super) fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let state = Shared::default();
    let host = state.clone();
    let child = state.clone();
    let foreign = state.clone();
    builder
        .manage(state)
        .register_uri_scheme_protocol(HOST, move |ctx, request| {
            reply(&host, ctx.webview_label(), HOST, request)
        })
        .register_uri_scheme_protocol(CHILD, move |ctx, request| {
            reply(&child, ctx.webview_label(), CHILD, request)
        })
        .register_uri_scheme_protocol(FOREIGN, move |ctx, request| {
            reply(&foreign, ctx.webview_label(), FOREIGN, request)
        })
}
pub(super) fn setup(app: &tauri::App) -> tauri::Result<()> {
    if !std::env::args_os().any(|a| a == "--diagram-isolation-spike") {
        return Ok(());
    }
    let state = app.state::<Shared>().inner().clone();
    let label = format!("{LABEL_PREFIX}{}", uuid::Uuid::new_v4().simple());
    let frame_probe = std::env::args_os().any(|a| a == "--diagram-isolation-frame-probe");
    *state.lock().unwrap() = Session {
        label: label.clone(),
        nonce: nonce(),
        live: true,
        served_host: false,
        served_child: false,
        started: Some(std::time::Instant::now()),
        frame_probe,
        served_foreign: false,
    };
    let host_url = format!("{}/", origin(HOST));
    let child_url = format!("{}/", origin(CHILD));
    let foreign_url = format!("{}/", origin(FOREIGN));
    let sibling_url = format!("{}/sibling.html", origin(CHILD));
    let navigation_state = state.clone();
    let window =
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(host_url.parse().unwrap()))
            .title("Synthetic diagram isolation probe")
            .disable_drag_drop_handler()
            .on_navigation(move |url| {
                // Some engines report subframe navigation here. Permit only the two
                // fixed documents; fragment carries no routing or filesystem authority.
                let mut clean = url.clone();
                clean.set_fragment(None);
                let allowed = clean.as_str() == host_url
                    || clean.as_str() == child_url
                    || (frame_probe
                        && (clean.as_str() == foreign_url || clean.as_str() == sibling_url));
                if !allowed {
                    navigation_state.lock().unwrap().live = false;
                }
                allowed
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .build();
    match window {
        Ok(window) => {
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    state.lock().unwrap().live = false;
                }
            });
            Ok(())
        }
        Err(error) => {
            state.lock().unwrap().live = false;
            Err(error)
        }
    }
}
/// Actual dispatch receipt, separate from browser CSP failure. No nonce/payload.
/// Feature-only, bounded constant command names; other callers are not logged.
pub(super) fn record_denied_ipc(label: &str, command: &str) {
    static RECEIPTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    if label.starts_with(LABEL_PREFIX)
        && RECEIPTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < 32
    {
        let command = match command {
            "native_read_path" | "native_get_grant" | "create_new_window" | "ai_send" => command,
            _ => "other",
        };
        eprintln!(
            "MDW_DIAGRAM_IPC_DENIED {}",
            serde_json::json!({"command":command})
        );
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> Shared {
        Arc::new(Mutex::new(Session {
            label: "diagram-spike-test".into(),
            nonce: "a".repeat(32),
            live: true,
            served_host: false,
            served_child: false,
            started: Some(std::time::Instant::now()),
            frame_probe: false,
            served_foreign: false,
        }))
    }
    fn request(path: &str) -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder()
            .uri(format!("mdwdiagramhost://localhost{path}"))
            .body(vec![])
            .unwrap()
    }
    #[test]
    fn exact_routes_and_actual_owner_only() {
        let s = state();
        for label in ["main", "window-1", "print-preview", "diagram-spike-old"] {
            assert_eq!(reply(&s, label, HOST, request("/")).status(), 403);
        }
        for path in [
            "/../host.mjs",
            "/%2e%2e/host.mjs",
            "/host.mjs?x=1",
            "/index.html",
        ] {
            assert_eq!(
                reply(&s, "diagram-spike-test", HOST, request(path)).status(),
                403
            );
        }
        assert_eq!(
            reply(&s, "diagram-spike-test", HOST, request("/")).status(),
            200
        );
        assert_eq!(
            reply(&s, "diagram-spike-test", HOST, request("/")).status(),
            410
        );
        assert_eq!(
            reply(&s, "diagram-spike-test", HOST, request("/host.mjs")).status(),
            403
        );
    }
    #[test]
    fn wrong_method_dead_session_and_route_crossing_fail() {
        let s = state();
        let mut req = request("/host.mjs");
        *req.method_mut() = tauri::http::Method::POST;
        assert_eq!(reply(&s, "diagram-spike-test", HOST, req).status(), 403);
        assert_eq!(
            reply(&s, "diagram-spike-test", CHILD, request("/host.mjs")).status(),
            403
        );
        s.lock().unwrap().live = false;
        assert_eq!(
            reply(&s, "diagram-spike-test", CHILD, request("/")).status(),
            403
        );
    }
    #[test]
    fn native_deadline_and_child_reload_retire_assets() {
        let s = state();
        assert_eq!(
            reply(&s, "diagram-spike-test", CHILD, request("/")).status(),
            200
        );
        assert_eq!(
            reply(&s, "diagram-spike-test", CHILD, request("/")).status(),
            410
        );
        assert_eq!(
            reply(&s, "diagram-spike-test", HOST, request("/host.mjs")).status(),
            403
        );
        let s = state();
        s.lock().unwrap().started =
            Some(std::time::Instant::now() - std::time::Duration::from_secs(10));
        assert_eq!(
            reply(&s, "diagram-spike-test", HOST, request("/")).status(),
            403
        );
    }
    #[test]
    fn response_has_exact_csp_mime_and_no_cache() {
        let s = state();
        let r = reply(&s, "diagram-spike-test", CHILD, request("/child.mjs"));
        assert_eq!(
            r.headers()["content-type"],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(r.headers()["cache-control"], "no-store");
        assert_eq!(r.headers()["content-security-policy"], policy(true));
        let foreign = tauri::http::Request::builder()
            .uri("http://mdwdiagramfixture.localhost/host.mjs")
            .body(vec![])
            .unwrap();
        assert_eq!(reply(&s, "diagram-spike-test", HOST, foreign).status(), 403);
    }
    #[test]
    fn policies_have_no_ambient_network_or_ipc() {
        for child in [true, false] {
            let p = policy(child);
            assert!(p.contains("connect-src 'none'"));
            assert!(!p.contains("unsafe-"));
            assert!(!p.contains("ipc:"));
        }
    }
    #[test]
    fn frame_probe_routes_require_mode_and_actual_owner() {
        let s = state();
        let req = |scheme: &str, path: &str| {
            tauri::http::Request::builder()
                .uri(format!("http://{scheme}.localhost{path}"))
                .body(Vec::new())
                .unwrap()
        };
        for (scheme, path) in [
            (FOREIGN, "/"),
            (FOREIGN, "/peer.mjs"),
            (CHILD, "/sibling.html"),
            (CHILD, "/peer.mjs"),
        ] {
            assert_eq!(
                reply(&s, "diagram-spike-test", scheme, req(scheme, path)).status(),
                403
            );
        }
        s.lock().unwrap().frame_probe = true;
        for (scheme, path) in [
            (FOREIGN, "/"),
            (FOREIGN, "/peer.mjs"),
            (CHILD, "/sibling.html"),
            (CHILD, "/peer.mjs"),
        ] {
            assert_eq!(reply(&s, "main", scheme, req(scheme, path)).status(), 403);
            assert_eq!(
                reply(&s, "diagram-spike-test", scheme, req(scheme, path)).status(),
                200
            );
        }
        assert_eq!(
            reply(&s, "diagram-spike-test", FOREIGN, req(FOREIGN, "/")).status(),
            410
        );
        assert_eq!(
            reply(&s, "diagram-spike-test", CHILD, req(CHILD, "/")).status(),
            403
        );
    }
    #[test]
    fn frame_probe_keeps_restrictive_csp_and_nosniff_headers() {
        let s = state();
        s.lock().unwrap().frame_probe = true;
        let host = reply(&s, "diagram-spike-test", HOST, request("/host.mjs"));
        let csp = host.headers()["content-security-policy"].to_str().unwrap();
        assert!(csp.contains(&format!("frame-src {} {}", origin(CHILD), origin(FOREIGN))));
        assert!(csp.contains("connect-src 'none'"));
        for scheme in [FOREIGN, CHILD] {
            let request = tauri::http::Request::builder()
                .uri(format!("http://{scheme}.localhost/peer.mjs"))
                .body(Vec::new())
                .unwrap();
            let peer = reply(&s, "diagram-spike-test", scheme, request);
            assert_eq!(peer.headers()["content-security-policy"], policy(true));
            assert_eq!(peer.headers()["x-content-type-options"], "nosniff");
        }
    }
}
