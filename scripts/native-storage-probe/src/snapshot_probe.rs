//! Actual process termination is a visibility experiment, never a power-loss test.
use crate::{
    kill_process::{emit, OwnedChild},
    resources::{
        journal_frame::encode_frame,
        journal_replay::{ReplayStatus, SnapshotVerification},
        private_store::{
            probe::{self, Boundary},
            PrivateSession, SnapshotSession, SnapshotStoreError,
        },
        transaction::{JournalRecord, PriorState, Sha256Digest, TargetRecord, TransactionId},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, Read, Write},
    sync::OnceLock,
};
const BEFORE: &[u8] = b"\xef\xbb\xbfsynthetic-before\r\n \xff";
const AFTER: &[u8] = b"synthetic-after\r\n\t\xff";
static TARGET: OnceLock<Boundary> = OnceLock::new();
static IDENTIFIER: OnceLock<String> = OnceLock::new();
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Message {
    Ready {
        boundary: Boundary,
        identifier: String,
    },
    Done {
        exact: bool,
        cleaned: bool,
    },
    Observed {
        exact: bool,
        verified_bytes: bool,
        unverified: bool,
    },
    Failed {
        reason: String,
    },
}
fn name(boundary: Boundary) -> &'static str {
    match boundary {
        Boundary::BeforeSnapshot => "before_snapshot",
        Boundary::PartialSnapshot => "partial_snapshot",
        Boundary::SnapshotFlushed => "snapshot_flushed",
        Boundary::SnapshotPrepared => "snapshot_prepared",
        _ => "invalid",
    }
}
fn parse(value: &str) -> Option<Boundary> {
    [
        Boundary::BeforeSnapshot,
        Boundary::PartialSnapshot,
        Boundary::SnapshotFlushed,
        Boundary::SnapshotPrepared,
    ]
    .into_iter()
    .find(|b| name(*b) == value)
}
fn record() -> JournalRecord {
    use sha2::{Digest, Sha256};
    let hash = |v: &[u8]| Sha256Digest::parse(&format!("{:x}", Sha256::digest(v))).unwrap();
    JournalRecord::new(
        TransactionId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap(),
        TargetRecord::new(
            "synthetic-document.md".into(),
            PriorState::Hash { hash: hash(BEFORE) },
            hash(AFTER),
            AFTER.len() as u64,
        )
        .unwrap(),
        vec![],
    )
    .unwrap()
}
fn expected(id: &str, boundary: Boundary) -> Option<Vec<u8>> {
    if boundary == Boundary::BeforeSnapshot {
        return None;
    }
    let mut bytes = probe::snapshot_bytes(id, &record(), Some(BEFORE), AFTER).unwrap();
    if boundary == Boundary::PartialSnapshot {
        bytes.truncate(probe::FIRST_FRAGMENT);
    }
    Some(bytes)
}
fn hook(boundary: Boundary, id: Option<&str>) {
    if let Some(id) = id {
        let _ = IDENTIFIER.set(id.to_owned());
    }
    if TARGET.get() != Some(&boundary) {
        return;
    }
    let result = (|| {
        emit(&Message::Ready {
            boundary,
            identifier: IDENTIFIER.get().ok_or("missing_identifier")?.clone(),
        })?;
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .take(16)
            .read_line(&mut line)
            .map_err(|_| "control_read")?;
        if line != "continue\n" {
            return Err("control_closed");
        }
        Ok(())
    })();
    if result.is_err() {
        std::process::exit(1);
    }
}
fn child(boundary: Boundary) -> Result<(), &'static str> {
    TARGET.set(boundary).map_err(|_| "duplicate_target")?;
    probe::install(hook).map_err(|_| "duplicate_hook")?;
    let session = match SnapshotSession::create(&record(), Some(BEFORE), AFTER) {
        Ok(session) => session,
        Err(failure) => {
            // Typed error contains only bounded operations/reasons/codes, never bytes or paths.
            let reason = serde_json::to_string(&failure.error).map_err(|_| "error_schema")?;
            if let Some(owner) = failure.owner {
                let _ = owner.cleanup();
            }
            let _ = emit(&Message::Failed { reason });
            std::process::exit(1);
        }
    };
    if session.observation().sequence != 1 {
        return Err("wrong_ack");
    }
    let owner = session.close();
    let exact = PrivateSession::inspect_document_snapshot(owner.identifier())
        .map(|v| v.before() == Some(BEFORE) && v.after() == AFTER)
        .unwrap_or(false);
    let cleaned = owner.cleanup().is_ok();
    emit(&Message::Done { exact, cleaned })?;
    if !exact || !cleaned {
        return Err("control_failed");
    }
    Ok(())
}
fn observe(id: &str, boundary: Boundary) -> Result<(), &'static str> {
    let bytes = expected(id, boundary);
    let exact_snapshot =
        PrivateSession::probe_snapshot_matches(id, record().id(), bytes.as_deref())
            .map_err(|_| "snapshot_exact_read_failed")?;
    let journal = if boundary == Boundary::SnapshotPrepared {
        encode_frame(1, &record()).unwrap()
    } else {
        vec![]
    };
    let exact_journal =
        PrivateSession::probe_matches(id, &journal).map_err(|_| "journal_exact_read_failed")?;
    let history = PrivateSession::inspect_existing(id).map_err(|_| "metadata_read_failed")?;
    let inspection = PrivateSession::inspect_document_snapshot(id);
    let verified_bytes = match inspection {
        Ok(v) => v.before() == Some(BEFORE) && v.after() == AFTER,
        Err(SnapshotStoreError::UnboundHistory) if boundary != Boundary::SnapshotPrepared => false,
        Err(_) => return Err("unexpected_snapshot_result"),
    };
    let valid = history.status() == ReplayStatus::CompletePrefix
        && history.last_sequence()
            == if boundary == Boundary::SnapshotPrepared {
                1
            } else {
                0
            };
    emit(&Message::Observed {
        exact: exact_snapshot && exact_journal && valid,
        verified_bytes,
        unverified: history.snapshots() == SnapshotVerification::Unverified,
    })
}
#[derive(Serialize)]
struct ResultRow {
    boundary: Boundary,
    kill: bool,
    reached: bool,
    passed: bool,
    residual_synthetic_store: bool,
    error: Option<String>,
}
fn valid_ready(actual: Boundary, wanted: Boundary, identifier: &str) -> bool {
    actual == wanted
        && uuid::Uuid::parse_str(identifier)
            .ok()
            .is_some_and(|id| !id.is_nil() && id.to_string() == identifier)
}
fn run_one(boundary: Boundary, kill: bool) -> ResultRow {
    let mut row = ResultRow {
        boundary,
        kill,
        reached: false,
        passed: false,
        residual_synthetic_store: false,
        error: None,
    };
    let result: Result<(), String> = (|| {
        let mut child = OwnedChild::spawn(&["--snapshot-kill-child", name(boundary)])?;
        // Creation may precede a failed handshake; conservatively report residual risk.
        row.residual_synthetic_store = true;
        let (actual, identifier) = match child.receive()? {
            Message::Ready {
                boundary,
                identifier,
            } => (boundary, identifier),
            Message::Failed { reason } => return Err(reason),
            _ => return Err("missing_ready".into()),
        };
        if !valid_ready(actual, boundary, &identifier) {
            return Err("invalid_ready".into());
        }
        row.reached = true;
        if kill {
            child.kill_and_reap()?;
            let mut reader =
                OwnedChild::spawn(&["--snapshot-kill-read", &identifier, name(boundary)])?;
            let Message::Observed {
                exact,
                verified_bytes,
                unverified,
            } = reader.receive()?
            else {
                return Err("missing_observation".into());
            };
            if !reader.wait()?.success()
                || !exact
                || !unverified
                || verified_bytes != (boundary == Boundary::SnapshotPrepared)
            {
                return Err("unexpected_observation".into());
            }
        } else {
            child.proceed()?;
            let Message::Done { exact, cleaned } = child.receive()? else {
                return Err("missing_control_done".into());
            };
            if !child.wait()?.success() || !exact || !cleaned {
                return Err("control_failed".into());
            }
            row.residual_synthetic_store = false;
        }
        Ok(())
    })();
    match result {
        Ok(()) => row.passed = true,
        Err(error) => row.error = Some(error),
    }
    row
}
#[derive(Serialize)]
struct Report {
    schema_version: u32,
    scope: &'static str,
    namespace: &'static str,
    snapshots: &'static str,
    passed: bool,
    results: Vec<ResultRow>,
}
pub fn dispatch() -> bool {
    let args: Vec<String> = std::env::args().collect();
    let result = if args.len() == 3 && args[1] == "--snapshot-kill-child" {
        Some(parse(&args[2]).ok_or("invalid_boundary").and_then(child))
    } else if args.len() == 4 && args[1] == "--snapshot-kill-read" {
        Some(
            parse(&args[3])
                .ok_or("invalid_boundary")
                .and_then(|b| observe(&args[2], b)),
        )
    } else {
        None
    };
    if let Some(result) = result {
        if let Err(reason) = result {
            let _ = emit(&Message::Failed {
                reason: reason.into(),
            });
            std::process::exit(1);
        }
        return true;
    }
    if args.len() != 2 || args[1] != "--snapshot-kill" {
        return false;
    }
    let results = [
        Boundary::BeforeSnapshot,
        Boundary::PartialSnapshot,
        Boundary::SnapshotFlushed,
        Boundary::SnapshotPrepared,
    ]
    .into_iter()
    .flat_map(|b| [run_one(b, false), run_one(b, true)])
    .collect::<Vec<_>>();
    let report = Report {
        schema_version: 1,
        scope: "snapshot_process_kill_visibility_only",
        namespace: "unestablished",
        snapshots: "unverified",
        passed: results.iter().all(|r| r.passed),
        results,
    };
    let bytes = serde_json::to_vec(&report).unwrap();
    assert!(bytes.len() < 16384);
    std::io::stdout().write_all(&bytes).unwrap();
    println!();
    if !report.passed {
        std::process::exit(1);
    }
    true
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_prefix_and_record_hash_contract() {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        assert!(expected(id, Boundary::BeforeSnapshot).is_none());
        assert_eq!(
            expected(id, Boundary::PartialSnapshot).unwrap(),
            expected(id, Boundary::SnapshotFlushed).unwrap()[..17]
        );
        assert_eq!(
            expected(id, Boundary::SnapshotFlushed),
            expected(id, Boundary::SnapshotPrepared)
        );
        assert!(parse("../path").is_none());
    }
    #[test]
    fn forged_handshake_never_qualifies() {
        assert!(!valid_ready(
            Boundary::PartialSnapshot,
            Boundary::SnapshotPrepared,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        ));
        assert!(!valid_ready(
            Boundary::BeforeSnapshot,
            Boundary::BeforeSnapshot,
            "../path"
        ));
    }
}
