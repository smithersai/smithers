//! Native integration tests for the six `Jj` contract ops, run against real
//! tempdir repos through jj-lib — no `jj` binary involved.
//!
//! Every op call constructs fresh state from disk (there is no long-lived
//! session object), so each assertion after the first also proves
//! reload-survival: a "new instance" over the same tree sees prior snapshots.

use std::fs;
use std::path::Path;
use std::path::PathBuf;

use flows_jj::error::ErrorCode;
use flows_jj::ops;
use jj_lib::config::ConfigLayer;
use jj_lib::config::ConfigSource;
use jj_lib::config::StackedConfig;
use jj_lib::default_backend_factories::default_backend_factories;
use jj_lib::default_backend_factories::default_working_copy_factories;
use jj_lib::object_id::HexPrefix;
use jj_lib::object_id::PrefixResolution;
use jj_lib::repo::Repo as _;
use jj_lib::settings::UserSettings;
use jj_lib::workspace::Workspace;
use pollster::FutureExt as _;
use tempfile::TempDir;

/// The identity `ops` records on commits, repeated so this test can open the
/// same repos with jj-lib directly.
const USER_CONFIG: &str = r#"
user.name = "Flows"
user.email = "flows@localhost"
operation.hostname = "flows"
operation.username = "flows"
"#;

fn temp_root() -> (TempDir, PathBuf) {
    let temp_dir = tempfile::Builder::new()
        .prefix("flows-jj-test-")
        .tempdir()
        .unwrap();
    let root = temp_dir.path().join("repo");
    (temp_dir, root)
}

fn write(root: &Path, name: &str, contents: impl AsRef<[u8]>) {
    fs::create_dir_all(root).unwrap();
    fs::write(root.join(name), contents).unwrap();
}

fn read(root: &Path, name: &str) -> String {
    String::from_utf8(fs::read(root.join(name)).unwrap()).unwrap()
}

/// The description jj persisted on `change_id`, read from the repo with
/// jj-lib. The six ops return ids and rendered text and never echo the
/// message back, so nothing in the contract itself observes the describe
/// step `snapshot` performs.
fn description(root: &Path, change_id: &str) -> String {
    let mut config = StackedConfig::with_defaults();
    config.add_layer(ConfigLayer::parse(ConfigSource::User, USER_CONFIG).unwrap());
    let settings = UserSettings::from_config(config).unwrap();
    let workspace = Workspace::load(
        &settings,
        root,
        &default_backend_factories(),
        &default_working_copy_factories(),
    )
    .unwrap();
    let repo = workspace
        .repo_loader()
        .clone()
        .load_at_head()
        .block_on()
        .unwrap();
    let prefix = HexPrefix::try_from_reverse_hex(change_id).unwrap();
    let PrefixResolution::SingleMatch(targets) = repo.resolve_change_id_prefix(&prefix).unwrap()
    else {
        panic!("change id {change_id:?} does not resolve to one change");
    };
    let visible: Vec<_> = targets
        .visible_with_offsets()
        .map(|(_offset, commit_id)| commit_id)
        .collect();
    let [commit_id] = visible[..] else {
        panic!("change id {change_id:?} is hidden or divergent");
    };
    repo.store()
        .get_commit(commit_id)
        .unwrap()
        .description()
        .to_owned()
}

/// The working-copy change id, as `status` reports it on its last line.
fn current_change_id(root: &Path) -> String {
    let status = ops::status(root).unwrap();
    status.trim_end().rsplit(' ').next().unwrap().to_owned()
}

#[track_caller]
fn assert_commit_id(id: &str) {
    // SimpleBackend commit ids are BLAKE2b-512: 128 hex characters.
    assert_eq!(id.len(), 128, "commit id {id:?} should be 128 chars");
    assert!(
        id.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "commit id {id:?} should be lowercase hex"
    );
}

#[track_caller]
fn assert_change_id(id: &str) {
    assert_eq!(id.len(), 12, "change id {id:?} should be 12 chars");
    assert!(
        id.chars().all(|c| ('k'..='z').contains(&c)),
        "change id {id:?} should be reverse hex (k-z)"
    );
}

#[test]
fn init_creates_repo_and_is_idempotent() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    ops::init(&root).unwrap();
    assert!(root.join(".jj").is_dir());
    // A second init over the same root must not fail or reset anything.
    write(&root, "a.txt", "alpha\n");
    ops::init(&root).unwrap();
    assert_eq!(read(&root, "a.txt"), "alpha\n");
}

#[test]
fn snapshot_returns_change_id_and_opens_fresh_change() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    // Repository creation is explicit.
    write(&root, "a.txt", "alpha\n");
    let first = ops::snapshot(&root, Some("first")).unwrap();
    assert_commit_id(&first.commit_id);
    let id1 = first.change_id;
    assert_change_id(&id1);

    // The closed change keeps the files; the fresh change on top is empty.
    let status = ops::status(&root).unwrap();
    assert!(
        status.starts_with("The working copy has no changes.\n"),
        "unexpected status: {status:?}"
    );
    let current_id = status.trim_end().rsplit(' ').next().unwrap();
    assert_change_id(current_id);
    assert_ne!(current_id, id1, "snapshot must open a fresh change");

    // Snapshotting again (no edits) closes the fresh change and opens another.
    let id2 = ops::snapshot(&root, None).unwrap().change_id;
    assert_change_id(&id2);
    assert_ne!(id2, id1);
    assert_eq!(
        id2, current_id,
        "second snapshot closes the change status reported"
    );
}

#[test]
fn restore_roundtrip_across_add_modify_delete() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "a.txt", "alpha\n");
    write(&root, "b.txt", "bravo\n");
    let s1 = ops::snapshot(&root, Some("s1")).unwrap().commit_id;

    write(&root, "a.txt", "alpha two\n");
    fs::remove_file(root.join("b.txt")).unwrap();
    write(&root, "c.txt", "charlie\n");
    let s2 = ops::snapshot(&root, Some("s2")).unwrap().commit_id;

    ops::restore(&root, &s1).unwrap();
    assert_eq!(read(&root, "a.txt"), "alpha\n");
    assert_eq!(read(&root, "b.txt"), "bravo\n");
    assert!(!root.join("c.txt").exists());

    ops::restore(&root, &s2).unwrap();
    assert_eq!(read(&root, "a.txt"), "alpha two\n");
    assert!(!root.join("b.txt").exists());
    assert_eq!(read(&root, "c.txt"), "charlie\n");
}

#[test]
fn restore_to_current_state_is_a_no_op() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "a.txt", "alpha\n");
    let s1 = ops::snapshot(&root, None).unwrap().commit_id;
    ops::restore(&root, &s1).unwrap();
    assert_eq!(read(&root, "a.txt"), "alpha\n");
}

#[test]
fn restore_unknown_or_malformed_id_is_invalid_ref() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "a.txt", "alpha\n");
    ops::snapshot(&root, None).unwrap();

    // Well-formed reverse-hex id that matches nothing.
    let err = ops::restore(&root, "kkkkkkkkkkkk").unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidRef, "{}", err.message);
    assert!(err.message.contains("doesn't exist"), "{}", err.message);

    // Malformed: neither reverse hex nor hex.
    let err = ops::restore(&root, "not-a-rev!").unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidRef);

    // Empty.
    let err = ops::restore(&root, "").unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidRef);
}

#[test]
fn diff_between_ids_and_identity() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "greeting.txt", "hello\nworld\n");
    write(&root, "gone.txt", "bye\n");
    let s1 = ops::snapshot(&root, Some("s1")).unwrap().commit_id;

    write(&root, "greeting.txt", "hello\nthere\nworld\n");
    fs::remove_file(root.join("gone.txt")).unwrap();
    write(&root, "fresh.txt", "fresh\n");
    let s2 = ops::snapshot(&root, Some("s2")).unwrap().commit_id;

    // Identity: no output at all.
    assert_eq!(ops::diff(&root, &s1, &s1).unwrap(), "");
    assert_eq!(ops::diff(&root, &s2, &s2).unwrap(), "");

    let forward = ops::diff(&root, &s1, &s2).unwrap();
    let expected = "\
diff --git a/fresh.txt b/fresh.txt
new file mode 100644
index 0000000000..0000000000
--- /dev/null
+++ b/fresh.txt
@@ -0,0 +1,1 @@
+fresh
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 0000000000..0000000000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
diff --git a/greeting.txt b/greeting.txt
index 0000000000..0000000000 100644
--- a/greeting.txt
+++ b/greeting.txt
@@ -1,2 +1,3 @@
 hello
+there
 world
";
    assert_eq!(forward, normalize_hashes(&forward, expected));

    // The reverse diff swaps adds and deletes.
    let reverse = ops::diff(&root, &s2, &s1).unwrap();
    assert!(reverse.contains("deleted file mode 100644"), "{reverse}");
    assert!(reverse.contains("--- a/fresh.txt"), "{reverse}");
    assert!(reverse.contains("+++ /dev/null"), "{reverse}");
    assert!(reverse.contains("+bye"), "{reverse}");
    assert!(reverse.contains("-there"), "{reverse}");
}

/// The `index <hash>..<hash>` lines carry content-hash prefixes. They are
/// deterministic for fixed content, but writing them out by hand would make
/// the fixtures unreadable — so expected strings carry the real structure and
/// borrow the hashes from the actual output line by line, after asserting the
/// line is an index line in both.
fn normalize_hashes(actual: &str, expected: &str) -> String {
    let actual_lines: Vec<&str> = actual.lines().collect();
    let expected_lines: Vec<&str> = expected.lines().collect();
    assert_eq!(
        actual_lines.len(),
        expected_lines.len(),
        "line count differs:\n--- actual ---\n{actual}\n--- expected ---\n{expected}"
    );
    let mut merged = String::new();
    for (actual_line, expected_line) in actual_lines.iter().zip(&expected_lines) {
        if expected_line.starts_with("index ") {
            assert!(
                actual_line.starts_with("index "),
                "expected an index line, got {actual_line:?}"
            );
            // Keep the mode suffix comparable: `index a..b 100644`.
            let expected_suffix = expected_line.splitn(3, ' ').nth(2);
            let actual_suffix = actual_line.splitn(3, ' ').nth(2);
            assert_eq!(
                actual_suffix, expected_suffix,
                "index line mode suffix differs"
            );
            merged.push_str(actual_line);
        } else {
            merged.push_str(expected_line);
        }
        merged.push('\n');
    }
    merged
}

#[test]
fn diff_multi_hunk_output_is_exact() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    let before: String = (1..=20).map(|i| format!("line {i}\n")).collect();
    write(&root, "long.txt", &before);
    let s1 = ops::snapshot(&root, None).unwrap().commit_id;

    let after = before
        .replace("line 2\n", "line two\n")
        .replace("line 18\n", "line eighteen\n");
    write(&root, "long.txt", &after);
    let s2 = ops::snapshot(&root, None).unwrap().commit_id;

    let diff = ops::diff(&root, &s1, &s2).unwrap();
    let expected = "\
diff --git a/long.txt b/long.txt
index 0000000000..0000000000 100644
--- a/long.txt
+++ b/long.txt
@@ -1,5 +1,5 @@
 line 1
-line 2
+line two
 line 3
 line 4
 line 5
@@ -15,6 +15,6 @@
 line 15
 line 16
 line 17
-line 18
+line eighteen
 line 19
 line 20
";
    assert_eq!(diff, normalize_hashes(&diff, expected));
}

#[test]
fn diff_binary_files() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "blob.bin", b"\x00\x01\x02");
    let s1 = ops::snapshot(&root, None).unwrap().commit_id;
    write(&root, "blob.bin", b"\x00\xff\xfe");
    let s2 = ops::snapshot(&root, None).unwrap().commit_id;

    let diff = ops::diff(&root, &s1, &s2).unwrap();
    assert!(
        diff.contains("Binary files a/blob.bin and b/blob.bin differ"),
        "{diff}"
    );
    assert!(
        !diff.contains("@@"),
        "binary diff must not contain hunks: {diff}"
    );
}

#[test]
fn diff_new_binary_file_uses_dev_null() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "keep.txt", "keep\n");
    let s1 = ops::snapshot(&root, None).unwrap().commit_id;
    write(&root, "blob.bin", b"\x00\x01");
    let s2 = ops::snapshot(&root, None).unwrap().commit_id;

    let diff = ops::diff(&root, &s1, &s2).unwrap();
    assert!(
        diff.contains("Binary files /dev/null and b/blob.bin differ"),
        "{diff}"
    );
}

#[test]
fn diff_rename_shows_as_delete_plus_add() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "old.txt", "same content\n");
    let s1 = ops::snapshot(&root, None).unwrap().commit_id;
    fs::rename(root.join("old.txt"), root.join("new.txt")).unwrap();
    let s2 = ops::snapshot(&root, None).unwrap().commit_id;

    let diff = ops::diff(&root, &s1, &s2).unwrap();
    assert!(diff.contains("diff --git a/new.txt b/new.txt"), "{diff}");
    assert!(diff.contains("new file mode 100644"), "{diff}");
    assert!(diff.contains("diff --git a/old.txt b/old.txt"), "{diff}");
    assert!(diff.contains("deleted file mode 100644"), "{diff}");
}

#[test]
fn status_reflects_working_copy_changes() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "a.txt", "alpha\n");
    write(&root, "b.txt", "bravo\n");
    ops::snapshot(&root, Some("baseline")).unwrap();

    write(&root, "a.txt", "alpha two\n");
    fs::remove_file(root.join("b.txt")).unwrap();
    write(&root, "c.txt", "charlie\n");

    let status = ops::status(&root).unwrap();
    let lines: Vec<&str> = status.lines().collect();
    assert_eq!(lines[0], "Working copy changes:");
    assert_eq!(lines[1], "A c.txt");
    assert_eq!(lines[2], "D b.txt");
    assert_eq!(lines[3], "M a.txt");
    let (prefix, id) = lines[4].split_at("Working copy  (@) : ".len());
    assert_eq!(prefix, "Working copy  (@) : ");
    assert_change_id(id);
    assert_eq!(lines.len(), 5);

    // status snapshots the working copy but must not change what it reports:
    // the current change still differs from its parent the same way.
    let again = ops::status(&root).unwrap();
    assert_eq!(status, again);
}

#[test]
fn workspace_add_and_forget() {
    let (temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "a.txt", "alpha\n");
    ops::snapshot(&root, Some("base")).unwrap();

    let lane = temp.path().join("lane1");
    ops::workspace_add(&root, "lane1", lane.to_str().unwrap()).unwrap();

    // The lane materializes the parent state of the main workspace's @.
    assert_eq!(read(&lane, "a.txt"), "alpha\n");

    // The lane is a fully usable working copy: snapshot works in it.
    write(&lane, "lane.txt", "from lane\n");
    let lane_id = ops::snapshot(&lane, Some("lane work")).unwrap().change_id;
    assert_change_id(&lane_id);

    // Its snapshot is visible from the main workspace's repo.
    let diff = ops::diff(&root, "@", &lane_id).unwrap();
    assert!(diff.contains("diff --git a/lane.txt b/lane.txt"), "{diff}");

    // Duplicate names are rejected while the workspace exists...
    let err = ops::workspace_add(&root, "lane1", temp.path().join("other").to_str().unwrap())
        .unwrap_err();
    assert!(err.message.contains("already exists"), "{}", err.message);

    // ...and free again after forget.
    ops::workspace_forget(&root, "lane1").unwrap();
    let lane2 = temp.path().join("lane2");
    ops::workspace_add(&root, "lane1", lane2.to_str().unwrap()).unwrap();

    // Forgetting a workspace that does not exist is a no-op, like the CLI.
    ops::workspace_forget(&root, "nonexistent").unwrap();
}

#[test]
fn snapshot_sets_description_on_closed_change() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "a.txt", "alpha\n");
    let s1 = ops::snapshot(&root, Some("the message")).unwrap().change_id;
    assert_eq!(description(&root, &s1), "the message");

    // The message lands on the change that closed, not on the fresh one
    // opened over it.
    let fresh = current_change_id(&root);
    assert_ne!(fresh, s1);
    assert_eq!(description(&root, &fresh), "");

    // The described change was committed: it resolves and restores.
    write(&root, "a.txt", "changed\n");
    ops::restore(&root, &s1).unwrap();
    assert_eq!(read(&root, "a.txt"), "alpha\n");
}

#[test]
fn snapshot_describes_only_the_change_it_closes() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "a.txt", "alpha\n");
    let described = ops::snapshot(&root, Some("the message")).unwrap().change_id;

    // `None` describes nothing and leaves earlier descriptions alone.
    write(&root, "b.txt", "beta\n");
    let undescribed = ops::snapshot(&root, None).unwrap().change_id;
    assert_eq!(description(&root, &undescribed), "");
    assert_eq!(description(&root, &described), "the message");

    // An empty message is still a message: it sets an empty description.
    write(&root, "c.txt", "gamma\n");
    let emptied = ops::snapshot(&root, Some("")).unwrap().change_id;
    assert_eq!(description(&root, &emptied), "");
    assert_eq!(description(&root, &described), "the message");
}

/// Folds the working copy into `snapshot`'s closed commit, the way an agent's
/// `jj squash` inside a step does: the closed change keeps its change id but
/// now points at a new commit holding the step's edits.
fn squash_working_copy_into(root: &Path, closed_commit: &str) {
    let mut config = StackedConfig::with_defaults();
    config.add_layer(ConfigLayer::parse(ConfigSource::User, USER_CONFIG).unwrap());
    let settings = UserSettings::from_config(config).unwrap();
    // Record the edits on @ first, through the contract.
    ops::status(root).unwrap();
    let workspace = Workspace::load(
        &settings,
        root,
        &default_backend_factories(),
        &default_working_copy_factories(),
    )
    .unwrap();
    let repo = workspace
        .repo_loader()
        .clone()
        .load_at_head()
        .block_on()
        .unwrap();
    let wc_id = repo
        .view()
        .get_wc_commit_id(workspace.workspace_name())
        .unwrap()
        .clone();
    let wc = repo.store().get_commit(&wc_id).unwrap();
    let prefix = HexPrefix::try_from_hex(closed_commit).unwrap();
    let PrefixResolution::SingleMatch(closed_id) =
        repo.index().resolve_commit_id_prefix(&prefix).unwrap()
    else {
        panic!("commit {closed_commit:?} does not resolve");
    };
    let closed = repo.store().get_commit(&closed_id).unwrap();
    let mut tx = repo.start_transaction();
    tx.repo_mut()
        .rewrite_commit(&closed)
        .set_tree(wc.tree())
        .write()
        .block_on()
        .unwrap();
    tx.repo_mut().rebase_descendants().block_on().unwrap();
    tx.commit("squash into the snapshot").block_on().unwrap();
}

#[test]
fn restore_by_commit_id_survives_a_rewrite_of_the_snapshot_change() {
    let (_temp, root) = temp_root();
    ops::init(&root).unwrap();
    write(&root, "f", "a");
    let snapshot = ops::snapshot(&root, None).unwrap();

    write(&root, "f", "b");
    squash_working_copy_into(&root, &snapshot.commit_id);

    // The change id now names the rewritten commit that holds the step's edit.
    ops::restore(&root, &snapshot.change_id).unwrap();
    assert_eq!(read(&root, "f"), "b");

    // The commit id still names the pre-image, although it is now hidden.
    ops::restore(&root, &snapshot.commit_id).unwrap();
    assert_eq!(read(&root, "f"), "a");
    assert_eq!(
        ops::diff(&root, &snapshot.commit_id, &snapshot.commit_id).unwrap(),
        ""
    );
}
