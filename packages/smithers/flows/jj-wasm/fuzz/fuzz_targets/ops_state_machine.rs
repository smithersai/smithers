#![no_main]

use std::collections::BTreeMap;
use std::path::Path;

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

#[derive(Debug, Arbitrary)]
enum Step {
    Write {
        name_idx: u8,
        subdir: bool,
        content: Vec<u8>,
    },
    Delete {
        name_idx: u8,
        subdir: bool,
    },
    Snapshot {
        message: Option<String>,
    },
    Status,
    Diff {
        from_idx: u8,
        to_idx: u8,
    },
    Restore {
        snap_idx: u8,
    },
    OpRestore {
        op_idx: u8,
    },
}

const NAMES: &[&str] = &[
    "a.txt",
    "b.bin",
    "file with spaces.md",
    "unicode-é-中.txt",
    "quote\"name.txt",
    "sub.txt",
];

fn rel_path(name_idx: u8, subdir: bool) -> String {
    let base = NAMES[(name_idx as usize) % NAMES.len()];
    if subdir {
        format!("dir/{base}")
    } else {
        base.to_owned()
    }
}

fn read_tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if name == ".jj" {
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

fuzz_target!(|steps: Vec<Step>| {
    if steps.is_empty() || steps.len() > 24 {
        return;
    }
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("repo");
    flows_jj::ops::init(&root).expect("init must succeed");

    let mut model: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut snapshots: Vec<(String, String, BTreeMap<String, Vec<u8>>)> = Vec::new();

    for step in steps {
        match step {
            Step::Write {
                name_idx,
                subdir,
                mut content,
            } => {
                content.truncate(2048);
                let rel = rel_path(name_idx, subdir);
                let full = root.join(&rel);
                if let Some(parent) = full.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(&full, &content).expect("write");
                model.insert(rel, content);
            }
            Step::Delete { name_idx, subdir } => {
                let rel = rel_path(name_idx, subdir);
                let full = root.join(&rel);
                let _ = std::fs::remove_file(&full);
                model.remove(&rel);
            }
            Step::Snapshot { message } => {
                let snap = flows_jj::ops::snapshot(&root, message.as_deref())
                    .expect("snapshot on healthy repo must succeed");
                assert!(!snap.commit_id.is_empty());
                assert!(!snap.change_id.is_empty());
                assert!(!snap.operation_id.is_empty());
                // Self-diff invariant: diff(x, x) is always empty.
                let self_diff = flows_jj::ops::diff(&root, &snap.commit_id, &snap.commit_id)
                    .expect("self diff must succeed");
                assert!(
                    self_diff.is_empty(),
                    "self diff must be empty, got: {self_diff}"
                );
                snapshots.push((snap.commit_id, snap.operation_id, model.clone()));
            }
            Step::Status => {
                let status = flows_jj::ops::status(&root).expect("status must succeed");
                assert!(
                    status.contains("Working copy  (@) : "),
                    "status missing wc header: {status}"
                );
            }
            Step::Diff { from_idx, to_idx } => {
                if snapshots.is_empty() {
                    continue;
                }
                let (from, _, _) = &snapshots[(from_idx as usize) % snapshots.len()];
                let (to, _, _) = &snapshots[(to_idx as usize) % snapshots.len()];
                let diff = flows_jj::ops::diff(&root, from, to)
                    .expect("diff between snapshots must succeed");
                if from == to {
                    assert!(diff.is_empty(), "identical snapshot diff must be empty");
                }
            }
            Step::Restore { snap_idx } => {
                if snapshots.is_empty() {
                    continue;
                }
                let (commit_id, _, expected) = &snapshots[(snap_idx as usize) % snapshots.len()];
                flows_jj::ops::restore(&root, commit_id)
                    .expect("restore to known snapshot must succeed");
                let actual = read_tree(&root);
                assert_eq!(
                    &actual, expected,
                    "restored tree diverged from snapshot oracle"
                );
                model = expected.clone();
            }
            Step::OpRestore { op_idx } => {
                if snapshots.is_empty() {
                    continue;
                }
                let (_, op_id, expected) = &snapshots[(op_idx as usize) % snapshots.len()];
                flows_jj::ops::op_restore(&root, op_id).expect("op_restore must succeed");
                let actual = read_tree(&root);
                assert_eq!(
                    &actual, expected,
                    "op_restore tree diverged from snapshot oracle"
                );
                model = expected.clone();
            }
        }
    }
});
