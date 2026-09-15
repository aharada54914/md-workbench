//! Synthetic consumer of product private storage; no alternative I/O implementation.
use crate::resources::{
    journal_replay::{MetadataOnlyHistory, ReplayStatus},
    private_store::{FreshJournalWriter, PrivateSession, StoreError},
    transaction::{JournalRecord, PriorState, Sha256Digest, Stage, TargetRecord, TransactionId},
};
use serde::Serialize;
use std::{
    io::Write,
    process::{Command, Stdio},
};
#[derive(Debug, Serialize)]
struct Observation {
    sequence: u64,
    bytes: usize,
    complete_prefix: bool,
    snapshots: &'static str,
}
fn observation(history: MetadataOnlyHistory) -> Observation {
    Observation {
        sequence: history.last_sequence(),
        bytes: history.validated_bytes(),
        complete_prefix: history.status() == ReplayStatus::CompletePrefix,
        snapshots: "unverified",
    }
}
fn emit(value: &impl Serialize) {
    let mut bytes = serde_json::to_vec(value).expect("bounded typed report");
    assert!(bytes.len() < 16384);
    bytes.push(b'\n');
    std::io::stdout()
        .lock()
        .write_all(&bytes)
        .expect("report output");
}
pub fn dispatch() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--metadata-read" {
        let result = PrivateSession::inspect_existing(&args[2]).map(observation);
        emit(&result);
        return true;
    }
    if args.len() != 2 || args[1] != "--metadata" {
        return false;
    }
    let report = run();
    emit(&report);
    if !report.passed {
        std::process::exit(1);
    }
    true
}
#[derive(Serialize)]
struct Report {
    schema_version: u32,
    scope: &'static str,
    namespace: &'static str,
    snapshots: &'static str,
    passed: bool,
    error: Option<StoreError>,
    consumer_error: Option<&'static str>,
    observations: Vec<Observation>,
    cleanup: Option<Result<(), StoreError>>,
}
fn run() -> Report {
    let mut report = Report {
        schema_version: 1,
        scope: "inactive_metadata_store",
        namespace: "unestablished",
        snapshots: "unverified",
        passed: false,
        error: None,
        consumer_error: None,
        observations: Vec::new(),
        cleanup: None,
    };
    let mut writer = match FreshJournalWriter::create() {
        Ok(v) => v,
        Err(e) => {
            report.error = Some(e);
            return report;
        }
    };
    let mut record = JournalRecord::new(
        TransactionId::parse(&uuid::Uuid::new_v4().to_string()).unwrap(),
        TargetRecord::new(
            "synthetic-document.md".into(),
            PriorState::Missing,
            Sha256Digest::parse(&"a".repeat(64)).unwrap(),
            0,
        )
        .unwrap(),
        vec![],
    )
    .unwrap();
    let exercise = (|| {
        writer.append(&record)?;
        for stage in [
            Stage::AssetDurable,
            Stage::DocumentDurable,
            Stage::Completed,
        ] {
            record.advance(stage).unwrap();
            writer.append(&record)?;
        }
        Ok::<(), StoreError>(())
    })();
    let session = writer.close();
    if let Err(error) = exercise {
        report.error = Some(error);
    } else {
        match session.inspect() {
            Ok(history) => {
                let local = observation(history);
                if local.sequence != 4 || !local.complete_prefix {
                    report.consumer_error = Some("unexpected_local_replay");
                }
                report.observations.push(local);
                // Spawn receives only a UUID, no descriptors/paths or authority.
                // The child resolves and validates the native base independently.
                match read_child(session.identifier()) {
                    Ok(remote)
                        if remote["Ok"]["sequence"] == 4
                            && remote["Ok"]["bytes"] == report.observations[0].bytes
                            && remote["Ok"]["complete_prefix"] == true
                            && remote["Ok"]["snapshots"] == "unverified" => {}
                    _ => report.consumer_error = Some("fresh_process_reopen_failed"),
                }
            }
            Err(error) => report.error = Some(error),
        }
    }
    report.cleanup = Some(session.cleanup());
    report.passed =
        report.error.is_none() && report.consumer_error.is_none() && report.cleanup == Some(Ok(()));
    report
}
fn read_child(id: &str) -> Result<serde_json::Value, ()> {
    let mut child = Command::new(std::env::current_exe().map_err(|_| ())?)
        .args(["--metadata-read", id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                use std::io::Read;
                let mut bytes = Vec::new();
                child
                    .stdout
                    .take()
                    .ok_or(())?
                    .take(16385)
                    .read_to_end(&mut bytes)
                    .map_err(|_| ())?;
                if !status.success() || bytes.len() > 16384 {
                    return Err(());
                }
                return serde_json::from_slice(&bytes).map_err(|_| ());
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(());
            }
        }
    }
}
