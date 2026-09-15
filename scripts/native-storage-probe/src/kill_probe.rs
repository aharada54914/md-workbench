//! Actual process termination is a visibility experiment, never a power-loss test.
use crate::{
    kill_process::{emit, OwnedChild},
    resources::{
        journal_frame::encode_frame,
        journal_replay::{ReplayStatus, SnapshotVerification},
        private_store::{
            probe::{self, Boundary},
            FreshJournalWriter, PrivateSession,
        },
        transaction::{JournalRecord, PriorState, Sha256Digest, TargetRecord, TransactionId},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, Read, Write},
    sync::OnceLock,
};
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
        sequence: u64,
        validated_bytes: usize,
        incomplete_tail: bool,
        unverified: bool,
    },
    Failed {
        reason: String,
    },
}
fn name(boundary: Boundary) -> &'static str {
    match boundary {
        Boundary::Bootstrap => "bootstrap",
        Boundary::PartialAppend => "partial_append",
        Boundary::FlushedBeforeAck => "flushed_before_ack",
        Boundary::AfterAck => "after_ack",
        Boundary::BeforeSnapshot => "before_snapshot",
        Boundary::PartialSnapshot => "partial_snapshot",
        Boundary::SnapshotFlushed => "snapshot_flushed",
        Boundary::SnapshotPrepared => "snapshot_prepared",
    }
}
fn parse(value: &str) -> Option<Boundary> {
    [
        Boundary::Bootstrap,
        Boundary::PartialAppend,
        Boundary::FlushedBeforeAck,
        Boundary::AfterAck,
    ]
    .into_iter()
    .find(|b| name(*b) == value)
}
fn record() -> JournalRecord {
    JournalRecord::new(
        TransactionId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap(),
        TargetRecord::new(
            "synthetic-document.md".into(),
            PriorState::Missing,
            Sha256Digest::parse(&"a".repeat(64)).unwrap(),
            0,
        )
        .unwrap(),
        vec![],
    )
    .unwrap()
}
fn expected(boundary: Boundary) -> Vec<u8> {
    let frame = encode_frame(1, &record()).unwrap();
    match boundary {
        Boundary::Bootstrap => vec![],
        Boundary::PartialAppend => frame[..probe::FIRST_FRAGMENT].to_vec(),
        _ => frame,
    }
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
    let mut writer = FreshJournalWriter::create().map_err(|_| "bootstrap_failed")?;
    let ack = writer.append(&record()).map_err(|_| "append_failed")?;
    if ack.sequence != 1 {
        return Err("wrong_ack");
    }
    probe::notify(Boundary::AfterAck, None);
    let session = writer.close();
    let exact = PrivateSession::probe_matches(session.identifier(), &expected(Boundary::AfterAck))
        .map_err(|_| "control_read_failed");
    let cleaned = session.cleanup().is_ok();
    emit(&Message::Done {
        exact: exact?,
        cleaned,
    })?;
    if !cleaned {
        return Err("control_cleanup_failed");
    }
    Ok(())
}
fn observe(id: &str, boundary: Boundary) -> Result<(), &'static str> {
    let bytes = expected(boundary);
    let exact = PrivateSession::probe_matches(id, &bytes).map_err(|_| "exact_read_failed")?;
    let history = PrivateSession::inspect_existing(id).map_err(|_| "metadata_read_failed")?;
    let sequence = if matches!(boundary, Boundary::Bootstrap | Boundary::PartialAppend) {
        0
    } else {
        1
    };
    let incomplete = boundary == Boundary::PartialAppend;
    let valid = history.last_sequence() == sequence
        && history.status()
            == if incomplete {
                ReplayStatus::IncompleteTail
            } else {
                ReplayStatus::CompletePrefix
            };
    emit(&Message::Observed {
        exact: exact && valid,
        sequence: history.last_sequence(),
        validated_bytes: history.validated_bytes(),
        incomplete_tail: incomplete,
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
    error: Option<&'static str>,
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
    let result = (|| {
        let mut child = OwnedChild::spawn(&["--metadata-kill-child", name(boundary)])?;
        // Creation may precede a failed handshake; conservatively report residual risk.
        row.residual_synthetic_store = true;
        let Message::Ready {
            boundary: actual,
            identifier,
        } = child.receive()?
        else {
            return Err("missing_ready");
        };
        if !valid_ready(actual, boundary, &identifier) {
            return Err("invalid_ready");
        }
        row.reached = true;
        if kill {
            child.kill_and_reap()?;
            let mut reader =
                OwnedChild::spawn(&["--metadata-kill-read", &identifier, name(boundary)])?;
            let Message::Observed {
                exact,
                sequence,
                validated_bytes,
                incomplete_tail,
                unverified,
            } = reader.receive()?
            else {
                return Err("missing_observation");
            };
            let length = expected(boundary).len();
            let wanted_seq = if matches!(boundary, Boundary::Bootstrap | Boundary::PartialAppend) {
                0
            } else {
                1
            };
            let wanted_extent = if wanted_seq == 0 { 0 } else { length };
            if !reader.wait()?.success()
                || !exact
                || !unverified
                || sequence != wanted_seq
                || validated_bytes != wanted_extent
                || incomplete_tail != (boundary == Boundary::PartialAppend)
            {
                return Err("unexpected_observation");
            }
        } else {
            child.proceed()?;
            let Message::Done { exact, cleaned } = child.receive()? else {
                return Err("missing_control_done");
            };
            if !child.wait()?.success() || !exact || !cleaned {
                return Err("control_failed");
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
    let result = if args.len() == 3 && args[1] == "--metadata-kill-child" {
        Some(parse(&args[2]).ok_or("invalid_boundary").and_then(child))
    } else if args.len() == 4 && args[1] == "--metadata-kill-read" {
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
    if args.len() != 2 || args[1] != "--metadata-kill" {
        return false;
    }
    let results = [
        Boundary::Bootstrap,
        Boundary::PartialAppend,
        Boundary::FlushedBeforeAck,
        Boundary::AfterAck,
    ]
    .into_iter()
    .flat_map(|b| [run_one(b, false), run_one(b, true)])
    .collect::<Vec<_>>();
    let report = Report {
        schema_version: 1,
        scope: "process_kill_visibility_only",
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
    fn exact_boundary_contract() {
        assert!(expected(Boundary::Bootstrap).is_empty());
        assert_eq!(
            expected(Boundary::PartialAppend),
            expected(Boundary::AfterAck)[..17]
        );
        assert_eq!(
            expected(Boundary::FlushedBeforeAck),
            expected(Boundary::AfterAck)
        );
        assert!(parse("../elsewhere").is_none());
    }
    #[test]
    fn wrong_boundary_and_noncanonical_identifier_never_count_as_ready() {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        assert!(valid_ready(Boundary::Bootstrap, Boundary::Bootstrap, id));
        assert!(!valid_ready(Boundary::AfterAck, Boundary::Bootstrap, id));
        for invalid in [
            "../elsewhere",
            "00000000-0000-0000-0000-000000000000",
            "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        ] {
            assert!(!valid_ready(
                Boundary::Bootstrap,
                Boundary::Bootstrap,
                invalid
            ));
        }
    }
}
