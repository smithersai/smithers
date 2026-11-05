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
use std::{fs, path::Path, process::Command};

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
