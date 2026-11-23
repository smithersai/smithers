#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;

#[derive(Debug, Arbitrary)]
struct DiffCase {
    filename_seed: u8,
    before: Vec<u8>,
    after: Vec<u8>,
}

const TRICKY_NAMES: &[&str] = &[
    "plain.txt",
    "has spaces.txt",
    "has\"quote.txt",
    "has\\backslash.txt",
    "has\ttab.txt",
    "nested/deep/file.bin",
    "unicode-日本語-🚀.md",
];

fuzz_target!(|case: DiffCase| {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("repo");
    flows_jj::ops::init(&root).expect("init");
    let name = TRICKY_NAMES[(case.filename_seed as usize) % TRICKY_NAMES.len()];
    let full = root.join(name);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let mut before = case.before;
    let mut after = case.after;
    before.truncate(4096);
    after.truncate(4096);

    std::fs::write(&full, &before).unwrap();
    let s1 = flows_jj::ops::snapshot(&root, Some("before")).expect("s1");
    std::fs::write(&full, &after).unwrap();
    let status = flows_jj::ops::status(&root).expect("status");
    assert!(status.contains("Working copy  (@) : "));
    // No raw unquoted tab/control character should break status line count.
    for line in status.lines() {
        assert!(!line.contains('\r'), "status leaked raw CR: {status:?}");
    }
    let s2 = flows_jj::ops::snapshot(&root, Some("after")).expect("s2");
    let diff = flows_jj::ops::diff(&root, &s1.commit_id, &s2.commit_id).expect("diff");
    if before == after {
        assert!(
            diff.is_empty(),
            "identical contents produced non-empty diff: {diff}"
        );
    } else {
        assert!(!diff.is_empty(), "changed contents produced empty diff");
    }
});
