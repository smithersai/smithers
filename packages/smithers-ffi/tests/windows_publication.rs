// The publication protocol runs on every host; Windows additionally exercises
// the native protected DACL, identity and FlushFileBuffers implementation.
#[path = "../src/atomic_glob.rs"]
mod atomic_glob;
#[path = "../src/atomic_protocol.rs"]
mod atomic_protocol;
#[cfg(windows)]
#[path = "../src/atomic_windows_handle.rs"]
mod atomic_windows_handle;
#[cfg(unix)]
#[path = "../src/atomic_fs.rs"]
mod native;
#[cfg(windows)]
#[path = "../src/atomic_windows_fs.rs"]
mod native;

use base64::Engine as _;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

fn identity(root: &Path) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let info = fs::metadata(root).unwrap();
        format!("{}:{}", info.dev(), info.ino())
    }
    #[cfg(windows)]
    {
        atomic_windows_handle::Directory::root(root)
            .unwrap()
            .identity()
            .unwrap()
    }
}

fn request(root: &Path, bytes: &[u8]) -> Value {
    json!({"operation":"writePrivateFile", "boundaryRoot":root, "logicalRoot":root,
        "rootIdentity":identity(root), "path":root.join("private/nested/snapshot"),
        "data":base64::engine::general_purpose::STANDARD.encode(bytes)})
}

fn publish(root: &Path, bytes: &[u8]) {
    let mut stages = Vec::new();
    native::run_observed(&request(root, bytes), 10000, 10000, &mut |stage| {
        stages.push(stage.to_owned())
    })
    .unwrap();
    assert_eq!(
        stages,
        [
            "temporary-created",
            "file-synced",
            "renamed",
            "directory-synced"
        ]
    );
    assert_eq!(
        fs::read(root.join("private/nested/snapshot")).unwrap(),
        bytes
    );
}

#[test]
fn publication_crash_child() {
    let Ok(root) = std::env::var("SMITHERS_PUBLICATION_CRASH_ROOT") else {
        return;
    };
    let root = Path::new(&root);
    let stop = std::env::var("SMITHERS_PUBLICATION_CRASH_STAGE").unwrap();
    native::run_observed(
        &request(root, b"complete new snapshot\n"),
        10000,
        10000,
        &mut |stage| {
            if stage == stop {
                // Abrupt exit bypasses all Rust destructors and publication cleanup.
                std::process::exit(73);
            }
        },
    )
    .unwrap();
    panic!("publication did not reach requested crash boundary");
}

#[test]
fn interrupted_publications_reopen_as_complete_old_or_new_snapshots() {
    for stage in [
        "temporary-created",
        "file-synced",
        "renamed",
        "directory-synced",
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        publish(&root, b"complete old snapshot\n");
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "publication_crash_child", "--nocapture"])
            .env("SMITHERS_PUBLICATION_CRASH_ROOT", &root)
            .env("SMITHERS_PUBLICATION_CRASH_STAGE", stage)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(73), "{stage}");
        let expected: &[u8] = if ["temporary-created", "file-synced"].contains(&stage) {
            b"complete old snapshot\n"
        } else {
            b"complete new snapshot\n"
        };
        assert_eq!(
            fs::read(root.join("private/nested/snapshot")).unwrap(),
            expected,
            "{stage}"
        );
        // A fresh owner recovers and re-publishes through any leftover scratch.
        publish(&root, b"complete recovered snapshot\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(root.join("private"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(root.join("private/nested"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(root.join("private/nested/snapshot"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        #[cfg(windows)]
        {
            let parent = atomic_windows_handle::Directory::root(&root)
                .unwrap()
                .private_child(std::ffi::OsStr::new("private"))
                .unwrap()
                .private_child(std::ffi::OsStr::new("nested"))
                .unwrap();
            atomic_windows_handle::verify_private(
                &parent.read_file(std::ffi::OsStr::new("snapshot")).unwrap(),
            )
            .unwrap();
        }
    }
}

#[test]
fn private_publication_refuses_aliases_without_changing_their_targets() {
    let temp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(temp.path()).unwrap();
    publish(&root, b"old snapshot");
    let target = root.join("private/nested/snapshot");
    fs::hard_link(&target, root.join("alias")).unwrap();
    assert!(
        native::run_observed(&request(&root, b"new secret"), 10000, 10000, &mut |_| {}).is_err()
    );
    assert_eq!(fs::read(&target).unwrap(), b"old snapshot");
    assert_eq!(fs::read(root.join("alias")).unwrap(), b"old snapshot");
}

#[test]
fn publication_protocol_child() {
    if std::env::var_os("SMITHERS_PUBLICATION_PROTOCOL_CHILD").is_some() {
        native::serve().unwrap();
    }
}

fn protocol(frame: &[u8]) -> std::process::Output {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "publication_protocol_child", "--nocapture"])
        .env("SMITHERS_PUBLICATION_PROTOCOL_CHILD", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(frame).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn framed_publication_entry_point_writes_exact_bytes() {
    for bytes in [b"".as_slice(), b"private snapshot\n", &[0, 255, 10, 0]] {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let body = serde_json::to_vec(&request(&root, bytes)).unwrap();
        let mut frame = format!("flows-atomic/1 {} 10000 10000 10000\n", body.len()).into_bytes();
        frame.extend(body);
        let output = protocol(&frame);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let start = output
            .stdout
            .windows(b"flows-atomic/1 ".len())
            .position(|part| part == b"flows-atomic/1 ")
            .expect("framed response");
        let response = &output.stdout[start..];
        let newline = response.iter().position(|byte| *byte == b'\n').unwrap();
        let length = std::str::from_utf8(&response[..newline])
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse::<usize>()
            .unwrap();
        let value: Value =
            serde_json::from_slice(&response[newline + 1..newline + 1 + length]).unwrap();
        assert_eq!(value["ok"], true, "{value}");
        assert_eq!(
            fs::read(root.join("private/nested/snapshot")).unwrap(),
            bytes
        );
    }
}

#[test]
fn framed_publication_refuses_truncated_or_oversized_requests_before_writing() {
    for invalid in ["truncated", "over-limit", "trailing"] {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let body = serde_json::to_vec(&request(&root, b"must not publish")).unwrap();
        let limit = if invalid == "over-limit" {
            body.len() - 1
        } else {
            10000
        };
        let mut frame = format!("flows-atomic/1 {} {limit} 10000 10000\n", body.len()).into_bytes();
        frame.extend(body);
        if invalid == "truncated" {
            frame.pop();
        }
        if invalid == "trailing" {
            frame.push(0);
        }
        let output = protocol(&frame);
        assert!(!output.status.success(), "{invalid} must fail");
        assert!(
            !root.join("private/nested/snapshot").exists(),
            "{invalid} must not write"
        );
    }
}
