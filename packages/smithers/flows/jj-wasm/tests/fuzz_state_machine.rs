//! Deterministic seeded state-machine and differential oracle fuzz suite for
//! `flows-jj`. Runs under standard `cargo test` on every platform; configure
//! intensity with `SMITHERS_FUZZ_CASES` and `SMITHERS_FUZZ_SEED`.
//! For coverage-guided libFuzzer campaigns on Linux, run `cargo +nightly fuzz run`.

use std::collections::BTreeMap;
use std::path::Path;

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed ^ 0x9e37_79b9_7f4a_7c15)
    }
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn usize(&mut self, bound: usize) -> usize {
        (self.next_u64() as usize) % bound
    }
    fn bytes(&mut self, max_len: usize) -> Vec<u8> {
        let len = self.usize(max_len + 1);
        (0..len).map(|_| (self.next_u64() & 0xff) as u8).collect()
    }
}

const NAMES: &[&str] = &[
    "a.txt",
    "binary.bin",
    "has spaces.md",
    "quote\"file.txt",
    "back\\slash.txt",
    "unicode-日本語-🚀.txt",
    "nested/deep/file.rs",
    "nested/other.txt",
];

fn read_tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_name() == ".jj" {
                continue;
            }
            if path.is_dir() {
                walk(base, &path, out);
            } else if path.is_file() {
                let rel = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.insert(rel, std::fs::read(&path).unwrap());
            }
        }
    }
    walk(root, root, &mut out);
    out
}

#[test]
fn fuzz_ops_state_machine_and_restore_oracle() {
    let seed: u64 = std::env::var("SMITHERS_FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20_261_122);
    let cases: usize = std::env::var("SMITHERS_FUZZ_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(16);

    let mut rng = Rng::new(seed);

    for case in 0..cases {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("repo");
        flows_jj::ops::init(&root).expect("init");

        let mut model: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        let mut snapshots: Vec<(String, String, BTreeMap<String, Vec<u8>>)> = Vec::new();
        let steps = 8 + rng.usize(12);

        for step in 0..steps {
            match rng.usize(7) {
                0 | 1 => {
                    let rel = NAMES[rng.usize(NAMES.len())].to_owned();
                    let content = if rng.usize(2) == 0 {
                        format!("case={case} step={step} val={}\nline2\n", rng.next_u64())
                            .into_bytes()
                    } else {
                        rng.bytes(512)
                    };
                    let full = root.join(&rel);
                    if let Some(p) = full.parent() {
                        std::fs::create_dir_all(p).unwrap();
                    }
                    std::fs::write(&full, &content).unwrap();
                    model.insert(rel, content);
                }
                2 => {
                    let rel = NAMES[rng.usize(NAMES.len())];
                    let _ = std::fs::remove_file(root.join(rel));
                    model.remove(rel);
                }
                3 => {
                    let snap = flows_jj::ops::snapshot(&root, Some(&format!("c{case}-s{step}")))
                        .expect("snapshot");
                    assert!(!snap.commit_id.is_empty());
                    assert!(!snap.change_id.is_empty());
                    assert!(!snap.operation_id.is_empty());
                    let self_diff = flows_jj::ops::diff(&root, &snap.commit_id, &snap.commit_id)
                        .expect("self diff");
                    assert!(
                        self_diff.is_empty(),
                        "case {case} step {step}: self diff non-empty"
                    );
                    snapshots.push((snap.commit_id, snap.operation_id, model.clone()));
                }
                4 => {
                    let status = flows_jj::ops::status(&root).expect("status");
                    assert!(status.contains("Working copy  (@) : "));
                    for line in status.lines() {
                        assert!(!line.contains('\r'), "raw CR leaked in status");
                    }
                }
                5 if !snapshots.is_empty() => {
                    let (a, _, ma) = &snapshots[rng.usize(snapshots.len())];
                    let (b, _, mb) = &snapshots[rng.usize(snapshots.len())];
                    let diff = flows_jj::ops::diff(&root, a, b).expect("diff");
                    if ma == mb {
                        assert!(diff.is_empty(), "equal trees had non-empty diff: {diff}");
                    } else {
                        assert!(!diff.is_empty(), "different trees had empty diff");
                    }
                }
                6 if !snapshots.is_empty() => {
                    let idx = rng.usize(snapshots.len());
                    let (commit_id, op_id, expected) = snapshots[idx].clone();
                    if rng.usize(2) == 0 {
                        flows_jj::ops::restore(&root, &commit_id).expect("restore");
                    } else {
                        flows_jj::ops::op_restore(&root, &op_id).expect("op_restore");
                    }
                    let actual = read_tree(&root);
                    assert_eq!(
                        actual, expected,
                        "case {case} step {step}: restored tree mismatch"
                    );
                    model = expected;
                }
                _ => {}
            }
        }
    }
}
