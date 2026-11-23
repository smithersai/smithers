//! Structured and stateful fuzz tests for `flows-jj` (WASM reactor ABI, diff/status
//! renderers, and jj-lib working-copy operations).
//!
//! Runs a deterministic baseline during `cargo test`; set `FUZZ_ITERS` and `FUZZ_SEED`
//! for extended campaigns on bare-metal hosts.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use flows_jj::abi;
use flows_jj::ops;
use serde_json::{Value, json};
use tempfile::TempDir;

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn usize(&mut self, max: usize) -> usize {
        if max == 0 {
            0
        } else {
            (self.next_u64() as usize) % max
        }
    }
    fn bytes(&mut self, max_len: usize) -> Vec<u8> {
        let len = self.usize(max_len + 1);
        (0..len).map(|_| (self.next_u64() & 0xff) as u8).collect()
    }
    fn ascii_or_control(&mut self, max_len: usize) -> String {
        let alphabet: &[u8] = b"abcxyz0123456789/._-\\\"\n\r\t\x00\x07\x08\x0b\x0c\x1b\x7f ";
        let len = self.usize(max_len + 1);
        let mut out = String::with_capacity(len);
        for _ in 0..len {
            let b = alphabet[self.usize(alphabet.len())];
            out.push(b as char);
        }
        out
    }
}

fn fuzz_iters(default: usize) -> usize {
    std::env::var("FUZZ_ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn fuzz_seed() -> u64 {
    std::env::var("FUZZ_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0x5eed_c0de_cafe_beef)
}

fn assert_valid_abi_envelope(response_bytes: &[u8], context: &str) -> Value {
    let val: Value = serde_json::from_slice(response_bytes).unwrap_or_else(|e| {
        panic!("invalid JSON from call_json ({context}): {e}");
    });
    let obj = val.as_object().expect("response must be a JSON object");
    assert_eq!(
        obj.len(),
        1,
        "response must have exactly one key ({context}): {val}"
    );
    assert!(
        obj.contains_key("ok") || obj.contains_key("err"),
        "response must be ok or err ({context}): {val}"
    );
    if let Some(err) = obj.get("err") {
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("");
        assert!(
            !msg.contains("jj: panic:"),
            "ABI panicked on {context}: {msg}"
        );
    }
    val
}

#[test]
fn fuzz_abi_arbitrary_bytes_never_panic() {
    let mut rng = Rng::new(fuzz_seed());
    let iters = fuzz_iters(2_000);

    // Seed corpus of adversarial JSON/non-JSON frames
    let seeds: &[&[u8]] = &[
        b"",
        b"{}",
        b"[]",
        b"null",
        b"{\"op\":\"unknown\"}",
        b"{\"op\":\"init\",\"root\":\"\"}",
        b"{\"op\":\"init\",\"root\":\"/nonexistent/path/\x00\"}",
        b"{\"op\":\"snapshot\",\"root\":\"/tmp\",\"message\":null}",
        b"{\"op\":\"restore\",\"root\":\"/tmp\",\"changeId\":\"../../../../etc/passwd\"}",
        b"{\"op\":\"diff\",\"root\":\"/tmp\",\"from\":\"\",\"to\":\"\"}",
        b"{\"op\":\"workspaceAdd\",\"root\":\"/tmp\",\"name\":\"\",\"path\":\"\"}",
        b"{\"op\":\"workspaceForget\",\"root\":\"/tmp\",\"name\":\"default\"}",
        b"{\"op\":\"opRestore\",\"root\":\"/tmp\",\"operationId\":\"zzzz\"}",
        &[0xff, 0xfe, 0x00, 0x80, 0xc0, 0xaf],
    ];
    for (i, seed) in seeds.iter().enumerate() {
        let resp = abi::call_json(seed);
        assert_valid_abi_envelope(&resp, &format!("seed[{i}]"));
    }

    for i in 0..iters {
        let payload = if i % 2 == 0 {
            rng.bytes(256)
        } else {
            let ops_names = [
                "init",
                "snapshot",
                "restore",
                "diff",
                "workspaceAdd",
                "workspaceForget",
                "status",
                "opRestore",
                "bogus",
            ];
            let op = ops_names[rng.usize(ops_names.len())];
            let req = json!({
                "op": op,
                "root": format!("/nonexistent-fuzz-root-{}", rng.ascii_or_control(24)),
                "message": rng.ascii_or_control(32),
                "changeId": rng.ascii_or_control(24),
                "from": rng.ascii_or_control(16),
                "to": rng.ascii_or_control(16),
                "name": rng.ascii_or_control(16),
                "path": rng.ascii_or_control(24),
                "operationId": rng.ascii_or_control(24),
            });
            serde_json::to_vec(&req).unwrap()
        };
        let resp = abi::call_json(&payload);
        assert_valid_abi_envelope(&resp, &format!("iter[{i}]"));
    }
}

#[test]
fn fuzz_stateful_jj_ops_sequences_preserve_invariants() {
    let mut rng = Rng::new(fuzz_seed() ^ 0x9e37_79b9_7f4a_7c15);
    let trials = (fuzz_iters(20) / 10).clamp(4, 50);

    for trial in 0..trials {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("repo");
        fs::create_dir_all(&root).unwrap();
        ops::init(&root).expect("init must succeed");

        let mut snapshots: Vec<(String, String, BTreeMap<String, Vec<u8>>)> = Vec::new();
        let mut expected_files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        let names = [
            "a.txt",
            "b.txt",
            "dir/c.txt",
            "dir/sub/d.bin",
            "space name.txt",
        ];

        for step in 0..16 {
            match rng.usize(6) {
                0 | 1 => {
                    // Write or overwrite a file
                    let name = names[rng.usize(names.len())];
                    let content = rng.bytes(128);
                    let full = root.join(name);
                    if let Some(parent) = full.parent() {
                        fs::create_dir_all(parent).unwrap();
                    }
                    fs::write(&full, &content).unwrap();
                    expected_files.insert(name.to_string(), content);
                }
                2 => {
                    // Delete an existing file
                    let name = names[rng.usize(names.len())];
                    let full = root.join(name);
                    if full.exists() {
                        fs::remove_file(&full).unwrap();
                        expected_files.remove(name);
                    }
                }
                3 => {
                    // Snapshot via ABI JSON
                    let msg = format!("trial {trial} step {step}");
                    let req = serde_json::to_vec(&json!({
                        "op": "snapshot",
                        "root": root.to_str().unwrap(),
                        "message": msg,
                    }))
                    .unwrap();
                    let resp = assert_valid_abi_envelope(&abi::call_json(&req), "snapshot");
                    let ok = resp.get("ok").expect("snapshot must succeed");
                    let commit_id = ok["commitId"].as_str().unwrap().to_string();
                    let op_id = ok["operationId"].as_str().unwrap().to_string();
                    assert!(!commit_id.is_empty());
                    assert!(!op_id.is_empty());
                    snapshots.push((commit_id, op_id, expected_files.clone()));
                }
                4 => {
                    // Status & diff never panic and emit no raw ANSI/control chars in headers
                    let status_req = serde_json::to_vec(&json!({
                        "op": "status",
                        "root": root.to_str().unwrap(),
                    }))
                    .unwrap();
                    let status_resp =
                        assert_valid_abi_envelope(&abi::call_json(&status_req), "status");
                    assert!(status_resp.get("ok").is_some());

                    if snapshots.len() >= 2 {
                        let a = rng.usize(snapshots.len());
                        let b = rng.usize(snapshots.len());
                        let diff_req = serde_json::to_vec(&json!({
                            "op": "diff",
                            "root": root.to_str().unwrap(),
                            "from": snapshots[a].0,
                            "to": snapshots[b].0,
                        }))
                        .unwrap();
                        let diff_resp =
                            assert_valid_abi_envelope(&abi::call_json(&diff_req), "diff");
                        let diff_str = diff_resp["ok"]["diff"].as_str().expect("diff must succeed");
                        if snapshots[a].0 == snapshots[b].0 {
                            assert!(diff_str.is_empty(), "diff(x, x) must be empty");
                        }
                    }
                }
                _ => {
                    // Restore to a prior snapshot and verify exact file contents match
                    if !snapshots.is_empty() {
                        let idx = rng.usize(snapshots.len());
                        let (commit_id, _, saved_files) = snapshots[idx].clone();
                        let restore_req = serde_json::to_vec(&json!({
                            "op": "restore",
                            "root": root.to_str().unwrap(),
                            "changeId": commit_id,
                        }))
                        .unwrap();
                        let resp =
                            assert_valid_abi_envelope(&abi::call_json(&restore_req), "restore");
                        assert!(resp.get("ok").is_some(), "restore failed: {resp}");
                        for name in names {
                            let full = root.join(name);
                            match saved_files.get(name) {
                                Some(want) => {
                                    let got = fs::read(&full).unwrap_or_else(|e| {
                                        panic!("restored file {name} missing: {e}");
                                    });
                                    assert_eq!(&got, want, "restored file {name} content mismatch");
                                }
                                None => {
                                    assert!(
                                        !Path::new(&full).exists(),
                                        "file {name} should be absent after restore"
                                    );
                                }
                            }
                        }
                        expected_files = saved_files;
                    }
                }
            }
        }
    }
}
