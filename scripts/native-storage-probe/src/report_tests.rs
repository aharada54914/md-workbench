use super::*;

#[test]
fn observations_distinguish_success_error_and_skipped_without_paths() {
    let mut report = Report::windows();
    report.filesystem = Some(Filesystem {
        filesystem_type: "NTFS".into(),
        flags: u32::MAX,
        max_component_length: 255,
    });
    report.set(
        Operation::FlushReadonlyDirectory,
        Outcome::Win32Error { code: 5 },
    );
    report.set(Operation::FlushFile, Outcome::Success);
    let json = report.to_json().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&json).unwrap();
    assert_eq!(value["scope"], "api_support_only");
    assert_eq!(value["operations"][4]["outcome"]["code"], 5);
    assert_eq!(value["operations"][9]["outcome"]["status"], "success");
    assert_eq!(value["operations"][10]["outcome"]["status"], "skipped");
    assert_eq!(value["directory_share"], 3);
    assert!(json.len() + 1 <= MAX_JSON_BYTES);
    assert!(!String::from_utf8(json).unwrap().contains("path"));
}

#[test]
fn unsupported_platform_never_reports_api_success() {
    let report = Report::unsupported();
    assert!(report.filesystem.is_none());
    assert!(report.operations.iter().all(|r| r.outcome
        == Outcome::Skipped {
            reason: Reason::UnsupportedPlatform,
        }));
    assert!(report.to_json().is_ok());
}

#[test]
fn schema_and_operation_order_are_fixed() {
    let mut report = Report::windows();
    report.schema_version = 2;
    assert!(report.to_json().is_err());
    report.schema_version = 1;
    report.operations.swap(0, 1);
    assert!(report.to_json().is_err());
    report.operations.swap(0, 1);
    report.operations.pop();
    assert!(report.to_json().is_err());
}

#[test]
fn arbitrary_or_unbounded_filesystem_strings_cannot_leak() {
    for name in ["", "C:\\Users\\name", "NTFS\nsecret", &"X".repeat(33)] {
        let mut report = Report::windows();
        report.filesystem = Some(Filesystem {
            filesystem_type: name.into(),
            flags: 0,
            max_component_length: 255,
        });
        assert!(report.to_json().is_err());
    }
    let mut report = Report::windows();
    report.filesystem = Some(Filesystem {
        filesystem_type: "X".repeat(32),
        flags: u32::MAX,
        max_component_length: u32::MAX,
    });
    for entry in &mut report.operations {
        entry.outcome = Outcome::Win32Error { code: u32::MAX };
    }
    assert!(report.to_json().unwrap().len() + 1 <= MAX_JSON_BYTES);
}

#[test]
fn non_ntfs_skips_do_not_overwrite_observed_results() {
    let mut report = Report::windows();
    report.set(Operation::QueryFilesystem, Outcome::Success);
    report.skip_remaining(Reason::NonNtfs);
    assert_eq!(report.operations[3].outcome, Outcome::Success);
    assert_eq!(
        report.operations[4].outcome,
        Outcome::Skipped {
            reason: Reason::NonNtfs
        }
    );
}
