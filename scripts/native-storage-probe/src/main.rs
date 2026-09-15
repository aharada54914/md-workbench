#[cfg(all(feature = "private-store-probe", any(windows, target_os = "macos")))]
mod kill_probe;
#[cfg(all(feature = "private-store-probe", any(windows, target_os = "macos")))]
mod kill_process;
#[cfg(any(windows, target_os = "macos"))]
mod metadata;
mod report;
mod resources;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod windows_acl;
#[cfg(windows)]
mod windows_acl_fixtures;

use std::io::Write;

fn main() {
    #[cfg(all(feature = "private-store-probe", any(windows, target_os = "macos")))]
    if kill_probe::dispatch() {
        return;
    }
    #[cfg(any(windows, target_os = "macos"))]
    if metadata::dispatch() {
        return;
    }
    // No caller-controlled paths or handles are accepted by the legacy diagnostic.
    if std::env::args_os().len() != 1 {
        eprintln!("This probe accepts no arguments.");
        std::process::exit(2);
    }
    #[cfg(windows)]
    let report = windows::run();
    #[cfg(not(windows))]
    let report = report::Report::unsupported();

    let Ok(mut json) = report.to_json() else {
        eprintln!("Probe report validation failed.");
        std::process::exit(1);
    };
    json.push(b'\n');
    if std::io::stdout().lock().write_all(&json).is_err() {
        std::process::exit(1);
    }
    // API errors are observations, not a harness failure. Consumers inspect outcomes.
}
