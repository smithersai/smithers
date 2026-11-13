use base64::Engine as _;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{symlink, MetadataExt};
#[cfg(windows)]
use std::os::windows::fs::symlink_dir as symlink;
use std::process::{Command, Stdio};

fn identity(path: &std::path::Path) -> String {
    #[cfg(unix)]
    {
        let info = fs::metadata(path).unwrap();
        format!("{}:{}", info.dev(), info.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        };
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .unwrap();
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the live file handle and output structure are valid.
        assert_ne!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) },
            0
        );
        let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        format!("{}:{index}", info.dwVolumeSerialNumber)
    }
}

fn invoke(request: Value) -> Value {
    invoke_with_limit(request, 10000)
}

fn invoke_with_limit(request: Value, response_limit: usize) -> Value {
    invoke_command(
        Command::new(env!("CARGO_BIN_EXE_smithers-jj-export")),
        request,
        response_limit,
    )
}

fn invoke_command(mut command: Command, request: Value, response_limit: usize) -> Value {
    let body = serde_json::to_vec(&request).unwrap();
    let mut child = command
        .arg("--atomic-fs")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        writeln!(
            stdin,
            "flows-atomic/1 {} 10000 10000 {response_limit}",
            body.len()
        )
        .unwrap();
        stdin.write_all(&body).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let newline = output
        .stdout
        .iter()
        .position(|byte| *byte == b'\n')
        .unwrap();
    let header = std::str::from_utf8(&output.stdout[..newline]).unwrap();
    let count: usize = header
        .strip_prefix("flows-atomic/1 ")
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(output.stdout.len() - newline - 1, count);
    serde_json::from_slice(&output.stdout[newline + 1..]).unwrap()
}

fn invoke_local(request: &Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_smithers-jj-export"))
        .arg("--local")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(request).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        output.status.success(),
        value.get("error").is_none(),
        "stdout: {} stderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    value
}

#[test]
fn native_patch_file_remains_accessible_to_atomic_fs() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let initialized = Command::new("jj")
        .args(["git", "init", root.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );
    let read = invoke_local(&json!({"operation":"read","repositoryPath":root}));
    let seed = json!({"operation":"apply_files","repositoryPath":root,
        "requestId":"22222222-2222-4222-8222-222222222222",
        "expectedOperationId":read["operationId"],"target":read["head"],
        "files":[{"path":"old.txt","content":"before\n"}]});
    let seeded = invoke_local(&seed);
    assert_eq!(seeded["status"], "accepted", "{seeded}");
    let digest = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(b"before\n"));
    let request = json!({"operation":"apply_files","repositoryPath":root,
        "requestId":"33333333-3333-4333-8333-333333333333",
        "expectedOperationId":seeded["operationId"],"target":seeded["head"],
        "files":[{"path":"old.txt","beforeDigest":digest,"content":"after\n"},
                 {"path":"new.txt","content":"new\n"}]});
    let applied = invoke_local(&request);
    assert_eq!(applied["status"], "accepted", "{applied}");
    assert_eq!(invoke_local(&request)["replayed"], true);
    let mut root_hash = gix::hash::hasher(gix::hash::Kind::Sha256);
    root_hash.update(root.to_string_lossy().as_bytes());
    let recovery = root
        .parent()
        .unwrap()
        .join(".smithers-coding-recovery")
        .join(root_hash.try_finalize().unwrap().to_string())
        .join("33333333-3333-4333-8333-333333333333");
    for (index, (name, contents)) in [("old.txt", "after\n"), ("new.txt", "new\n")]
        .iter()
        .enumerate()
    {
        let target = root.join(name);
        let common = json!({"boundaryRoot":root,"logicalRoot":root,
            "rootIdentity":identity(&root),"path":target});
        let mut read = common.clone();
        read["operation"] = json!("readFileString");
        let result = invoke(read);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(result["value"]["base64"].as_str().unwrap())
                .unwrap(),
            contents.as_bytes()
        );
        let mut batch = common.clone();
        batch["operation"] = json!("batch");
        batch["batchSize"] = json!(1);
        batch["batchEntry"] = json!(10000);
        batch["requests"] = json!([{"operation":"digest","path":target,"content":true}]);
        let result = invoke(batch);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(
            result["value"]["entries"][0]["result"]["ok"], true,
            "{result}"
        );
        assert_eq!(
            result["value"]["entries"][0]["result"]["value"]["digest"],
            format!(
                "{:x}",
                <sha2::Sha256 as sha2::Digest>::digest(contents.as_bytes())
            )
        );
        let mut write = common;
        write["operation"] = json!("writeFileString");
        write["data"] = json!("modified\n");
        let result = invoke(write);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(fs::read_to_string(&target).unwrap(), "modified\n");
        assert_eq!(
            fs::read_to_string(recovery.join(format!("{index}.after"))).unwrap(),
            *contents
        );
    }
}

#[test]
fn packaged_helper_writes_and_reads_without_an_interpreter() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let root_identity = identity(&root);
    let target = root.join("proof.txt");
    let common = json!({"boundaryRoot":root,"logicalRoot":root,
        "rootIdentity":root_identity,"path":target});
    let mut write = common.clone();
    write["operation"] = json!("writeFileString");
    write["data"] = json!("written by packaged Rust helper\n");
    assert_eq!(invoke(write), json!({"ok":true,"value":null}));
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        "written by packaged Rust helper\n"
    );
    let mut read = common;
    read["operation"] = json!("readFile");
    let answer = invoke(read);
    assert_eq!(answer["ok"], true);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(answer["value"]["base64"].as_str().unwrap())
            .unwrap(),
        b"written by packaged Rust helper\n"
    );
}

#[test]
fn packaged_stat_preserves_creation_time_for_roots_directories_and_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let root_identity = identity(&root);
    let nested = root.join("nested");
    fs::create_dir(&nested).unwrap();
    let file = nested.join("proof.txt");
    fs::write(&file, "creation time").unwrap();
    for path in [&root, &nested, &file] {
        let expected = fs::metadata(path).unwrap().created();
        let actual = invoke(json!({
            "operation":"stat", "boundaryRoot":root, "logicalRoot":root,
            "rootIdentity":root_identity, "path":path
        }));
        assert_eq!(actual["ok"], true, "{actual}");
        match expected {
            Ok(created) => {
                let milliseconds = created
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_secs_f64()
                    * 1000.0;
                let birthtime = actual["value"]["birthtime"].as_f64().unwrap();
                assert!((birthtime - milliseconds).abs() < 1.0);
            }
            Err(_) => assert!(actual["value"]["birthtime"].is_null()),
        }
    }
}

#[test]
fn packaged_exists_handles_missing_paths_without_hiding_refusals() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let root_identity = identity(&root);
    let request = |path: &std::path::Path| {
        json!({
            "operation":"exists", "boundaryRoot":root, "logicalRoot":root,
            "rootIdentity":root_identity, "path":path
        })
    };

    assert_eq!(
        invoke(request(&root.join("missing"))),
        json!({"ok":true,"value":false})
    );
    assert_eq!(
        invoke(request(&root.join("missing/child"))),
        json!({"ok":true,"value":false})
    );

    let nested = root.join("nested");
    fs::create_dir(&nested).unwrap();
    assert_eq!(
        invoke(request(&nested.join("missing"))),
        json!({"ok":true,"value":false})
    );

    symlink(&nested, root.join("link")).unwrap();
    assert_eq!(invoke(request(&root.join("link")))["code"], "ELOOP");
    let through_link = invoke(request(&root.join("link/child")));
    assert_eq!(through_link["ok"], false);
    assert!(through_link["code"] == "ELOOP" || through_link["code"] == "ENOTDIR");

    fs::write(root.join("file"), "data").unwrap();
    assert_eq!(invoke(request(&root.join("file/child")))["code"], "ENOTDIR");
    assert_eq!(invoke(request(&root.join("../outside")))["code"], "EPERM");
    let outside = tempfile::tempdir().unwrap();
    assert_eq!(
        invoke(request(&outside.path().join("missing")))["code"],
        "EPERM"
    );
}

#[test]
fn native_patch_rejects_invalid_edits_and_retains_deleted_preimages() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("repository");
    let initialized = Command::new("jj")
        .args(["git", "init"])
        .arg(&root)
        .output()
        .unwrap();
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );
    let read = invoke_local(&json!({"operation":"read", "repositoryPath":root}));
    let digest = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(b"before"));
    let mut request = json!({"operation":"apply_files", "repositoryPath":root,
        "requestId":"44444444-4444-4444-8444-444444444444",
        "expectedOperationId":read["operationId"], "target":read["head"]});
    for files in [
        json!([]),
        json!([{"path":"old.txt", "beforeDigest":"a".repeat(63), "content":"after"}]),
        json!([{"path":"old.txt", "beforeDigest":"A".repeat(64), "content":"after"}]),
        json!([{"path":"old.txt", "beforeDigest":"g".repeat(64), "content":"after"}]),
        json!([{"path":"old.txt", "beforeDigest":digest, "content":"before"}]),
        json!([{"path":"old.txt"}]),
        json!([{"path":"a", "content":"a"}, {"path":"a/b", "content":"b"}]),
        json!([{"path":"a/b", "content":"b"}, {"path":"a", "content":"a"}]),
        json!([{"path":"a", "content":"a"}, {"path":"a", "content":"b"}]),
    ] {
        request["files"] = files;
        let rejected = invoke_local(&request);
        assert_eq!(
            rejected["error"]["code"], "invalid_request",
            "{request}: {rejected}"
        );
        assert_eq!(
            fs::read_dir(&root).unwrap().count(),
            2,
            "only jj metadata should exist"
        );
        assert!(!temp.path().join(".smithers-coding-recovery").exists());
        let after = invoke_local(&json!({"operation":"read", "repositoryPath":root}));
        assert_eq!(after["operationId"], read["operationId"]);
    }
    request["files"] = json!([{"path":"old.txt", "content":"before"}]);
    let seeded = invoke_local(&request);
    assert_eq!(seeded["status"], "accepted", "{seeded}");
    request["requestId"] = json!("55555555-5555-4555-8555-555555555555");
    request["expectedOperationId"] = seeded["operationId"].clone();
    request["target"] = seeded["head"].clone();
    request["files"] = json!([{"path":"old.txt", "beforeDigest":digest}]);
    let deleted = invoke_local(&request);
    assert_eq!(deleted["status"], "accepted", "{deleted}");
    assert!(!root.join("old.txt").exists());
    let preimage = deleted["recovery"]["files"][0]["preimage"]
        .as_str()
        .unwrap();
    assert_eq!(fs::read(preimage).unwrap(), b"before");
    assert_eq!(invoke_local(&request)["replayed"], true);
}

#[test]
fn glob_response_limit_counts_only_selected_paths() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    fs::write(root.join("selected.txt"), "").unwrap();
    for index in 0..12 {
        fs::write(root.join(format!("{index}-{}.log", "x".repeat(160))), "").unwrap();
    }
    for (pattern, exclude) in [
        ("selected.txt", json!([])),
        ("*.txt", json!(["*.log"])),
        ("*", json!(["*.log"])),
    ] {
        let request = json!({"operation":"glob","boundaryRoot":root,"logicalRoot":root,
            "rootIdentity":identity(&root),"root":root,"pattern":pattern,
            "options":{"exclude":exclude}});
        let expected = json!({"ok":true,"value":[root.join("selected.txt")]});
        let exact = serde_json::to_vec(&expected).unwrap().len();
        assert!(exact < 512);
        assert_eq!(invoke_with_limit(request.clone(), 512), expected);
        assert_eq!(invoke_with_limit(request.clone(), exact), expected);
        assert_eq!(invoke_with_limit(request, exact - 1)["code"], "EFBIG");
    }
}

#[test]
fn glob_response_limit_includes_root_prefixes_escaping_and_framing() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path())
        .unwrap()
        .join("long-prefix".repeat(12));
    fs::create_dir(&root).unwrap();
    let mut names = vec!["one.txt", "two-λ.txt"];
    #[cfg(unix)]
    names.push("quote-\"-and-\n.txt");
    #[cfg(windows)]
    names.push("three.txt");
    for name in &names {
        fs::write(root.join(name), "").unwrap();
    }
    for pattern in ["*", "."] {
        let request = json!({"operation":"glob","boundaryRoot":root,"logicalRoot":root,
            "rootIdentity":identity(&root),"root":root,"pattern":pattern});
        let expected = if pattern == "." {
            json!({"ok":true,"value":[root]})
        } else {
            let mut paths = names.iter().map(|name| root.join(name)).collect::<Vec<_>>();
            paths.sort();
            json!({"ok":true,"value":paths})
        };
        let exact = serde_json::to_vec(&expected).unwrap().len();
        assert_eq!(invoke_with_limit(request.clone(), exact), expected);
        assert_eq!(invoke_with_limit(request, exact - 1)["code"], "EFBIG");
    }
}

#[cfg(unix)]
#[test]
fn metadata_changes_do_not_require_content_read_permission() {
    use std::os::unix::{fs::PermissionsExt, process::CommandExt};

    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let target = root.join("owned.txt");
    fs::write(&target, "preserved").unwrap();
    let privileged = unsafe { libc::geteuid() } == 0;
    let binary = if privileged {
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let binary = root.join("helper");
        fs::copy(env!("CARGO_BIN_EXE_smithers-jj-export"), &binary).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::ffi::CString::new(target.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::chown(path.as_ptr(), 65534, 65534) }, 0);
        binary
    } else {
        env!("CARGO_BIN_EXE_smithers-jj-export").into()
    };
    let execute = |request| {
        let mut command = Command::new(&binary);
        if privileged {
            command.gid(65534).uid(65534);
        }
        invoke_command(command, request, 10000)
    };
    let common = json!({"boundaryRoot":root,"logicalRoot":root,
        "rootIdentity":identity(&root),"path":target});
    for mode in [0, 0o200] {
        let mut chmod = common.clone();
        chmod["operation"] = json!("chmod");
        chmod["options"] = json!({"mode":mode});
        assert_eq!(execute(chmod.clone()), json!({"ok":true,"value":null}));
        let mut read = common.clone();
        read["operation"] = json!("readFile");
        assert_eq!(execute(read)["code"], "EACCES");
        let mut chown = common.clone();
        chown["operation"] = json!("chown");
        chown["options"] = json!({"uid":-1,"gid":-1});
        assert_eq!(execute(chown), json!({"ok":true,"value":null}));
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            mode
        );
        chmod["options"] = json!({"mode":0o600});
        assert_eq!(execute(chmod), json!({"ok":true,"value":null}));
        assert_eq!(fs::read_to_string(&target).unwrap(), "preserved");
    }
}
