use super::*;
use crate::resources::{journal_replay::SnapshotVerification, private_store::NamespaceDurability};
#[derive(Default)]
struct Fake {
    bytes: Vec<u8>,
    events: Vec<&'static str>,
    calls: usize,
    fail: Option<&'static str>,
    interrupted: bool,
}
impl Backend for Fake {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.calls += 1;
        if self.interrupted && self.calls == 2 {
            return Err(io::ErrorKind::Interrupted.into());
        }
        if self.fail == Some("write") && self.calls == 2 {
            return Err(io::Error::from_raw_os_error(28));
        }
        if self.fail == Some("zero") {
            return Ok(0);
        }
        let n = b.len().min(3);
        self.bytes.extend(&b[..n]);
        Ok(n)
    }
    fn flush_file(&mut self) -> Result<(), StoreError> {
        self.events.push("file");
        if self.fail == Some("file") {
            Err(StoreError::FlushUncertain {
                operation: Operation::FlushFile,
                code: Some(5),
            })
        } else {
            Ok(())
        }
    }
    fn flush_root(&mut self) -> Result<(), StoreError> {
        self.events.push("root");
        if self.fail == Some("root") {
            Err(StoreError::Io {
                operation: Operation::FlushRoot,
                code: Some(5),
            })
        } else {
            Ok(())
        }
    }
    fn verify(&mut self) -> Result<(), SnapshotStoreError> {
        self.events.push("verify");
        if self.fail == Some("verify") {
            Err(SnapshotError::HashMismatch.into())
        } else {
            Ok(())
        }
    }
    fn prepared(&mut self) -> Result<AppendObservation, StoreError> {
        self.events.push("prepared");
        if self.fail == Some("prepared") {
            Err(StoreError::WriteUncertain {
                operation: Operation::Write,
                code: Some(28),
            })
        } else {
            Ok(AppendObservation {
                sequence: 1,
                end_offset: 42,
                namespace: NamespaceDurability::Unestablished,
                snapshots: SnapshotVerification::Unverified,
            })
        }
    }
}
#[test]
fn short_writes_and_interrupted_retry_preserve_order_and_exact_bytes() {
    let mut b = Fake {
        interrupted: true,
        ..Default::default()
    };
    let ack = execute(&mut b, b"header", Some(b"before"), b"after").unwrap();
    assert_eq!(b.bytes, b"headerbeforeafter");
    assert_eq!(b.events, ["file", "root", "verify", "prepared"]);
    assert_eq!(ack.sequence, 1);
    assert_eq!(ack.snapshots, SnapshotVerification::Unverified);
}
#[test]
fn each_uncertain_boundary_stops_before_prepared() {
    for (fail, events) in [
        ("write", vec![]),
        ("zero", vec![]),
        ("file", vec!["file"]),
        ("root", vec!["file", "root"]),
        ("verify", vec!["file", "root", "verify"]),
        ("prepared", vec!["file", "root", "verify", "prepared"]),
    ] {
        let mut b = Fake {
            fail: Some(fail),
            ..Default::default()
        };
        assert!(execute(&mut b, b"header", Some(b"before"), b"after").is_err());
        assert_eq!(b.events, events);
        if fail == "write" {
            assert_eq!(b.bytes, b"hea");
        }
        if fail == "zero" {
            assert!(b.bytes.is_empty());
        }
    }
}
