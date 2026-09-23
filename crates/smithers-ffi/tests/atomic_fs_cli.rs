use base64::Engine as _;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::process::{Command, Stdio};

fn invoke(request: Value) -> Value {
    let body = serde_json::to_vec(&request).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_smithers-jj-export"))
        .arg("--atomic-fs")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        writeln!(stdin, "flows-atomic/1 {} 10000 10000 10000", body.len()).unwrap();
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

#[test]
fn packaged_helper_writes_and_reads_without_an_interpreter() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let info = fs::metadata(&root).unwrap();
    let target = root.join("proof.txt");
    let common = json!({"boundaryRoot":root,"logicalRoot":root,
        "rootIdentity":format!("{}:{}", info.dev(), info.ino()),"path":target});
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
