mod report;
#[cfg(windows)]
mod windows;

use std::io::Write;

fn main() {
    // No caller-controlled paths or handles are accepted by this diagnostic.
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
