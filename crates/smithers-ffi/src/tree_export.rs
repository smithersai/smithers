//! Materialize an immutable JJ tree without creating or updating a workspace.
use std::path::Path;

use anyhow::{bail, Context};
use jj_lib::backend::{CommitId, TreeValue};
use jj_lib::default_backend_factories::{
    default_backend_factories, default_working_copy_factories,
};
use jj_lib::merged_tree::MergedTree;
use jj_lib::object_id::ObjectId;
use jj_lib::workspace::Workspace;
use pollster::FutureExt as _;
use serde::Serialize;

use crate::jj_core::{create_settings, write_new_file_content_to, UserConfig};
use crate::JjError;

/// Guest-local export receipt. The caller owns removal of `path` after checks.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeExport {
    pub commit_id: String,
    pub change_id: String,
    pub tree_id: String,
    pub path: String,
    pub file_count: usize,
}

/// Read one full commit object directly from the existing store. Loading the
/// operation head could reconcile concurrent operations, so this deliberately
/// does not call `load_at_head`, snapshot, or any transaction API.
/// jj-lib may add keep refs and change-ID extras when importing a Git-native
/// object for the first time; operation heads, view and working copy stay put.
pub fn export_commit_tree(
    repository: &Path,
    commit_id: &str,
    output_parent: &Path,
) -> anyhow::Result<TreeExport> {
    let settings = create_settings(&UserConfig::default());
    let workspace = Workspace::load(
        &settings,
        repository,
        &default_backend_factories(),
        &default_working_copy_factories(),
    )?;
    let store = workspace.repo_loader().store();
    if commit_id.len() != store.commit_id_length() * 2
        || !commit_id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        bail!("expected a full lowercase immutable commit ID");
    }
    let commit = store
        .get_commit(&CommitId::try_from_hex(commit_id).context("invalid immutable commit ID")?)?;
    let tree = commit.tree();
    let tree_id = tree
        .tree_ids()
        .clone()
        .into_resolved()
        .map_err(|_| anyhow::anyhow!("cannot export an unresolved tree"))?
        .hex();
    let parent = output_parent
        .canonicalize()
        .context("output parent must already exist")?;
    let mut builder = tempfile::Builder::new();
    builder.prefix("smithers-check-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let directory = builder.tempdir_in(&parent)?;
    // Keep panic unwinding enabled: jj-lib can panic on malformed raw names,
    // and TempDir must still remove partial output while unwinding.
    let file_count =
        materialize(&tree, directory.path(), true).map_err(|err| anyhow::anyhow!("{err:?}"))?;
    let path = directory
        .path()
        .to_str()
        .context("export path must be UTF-8")?
        .to_owned();
    let _kept = directory.keep();
    Ok(TreeExport {
        commit_id: commit.id().hex(),
        change_id: commit.change_id().reverse_hex(),
        tree_id,
        path,
        file_count,
    })
}

/// Shared with the existing repository snapshot operation. Strict guest checks
/// reject metadata and unsupported submodules instead of exporting a partial tree.
pub(crate) fn materialize(
    tree: &MergedTree,
    output: &Path,
    strict: bool,
) -> Result<usize, JjError> {
    if !std::fs::symlink_metadata(output)
        .map_err(|err| JjError::Internal(format!("failed to inspect snapshot directory: {err}")))?
        .file_type()
        .is_dir()
    {
        return Err(JjError::BadRequest(
            "snapshot output must be a real directory".into(),
        ));
    }
    let store = tree.store();
    let mut file_count = 0;
    for (path, value) in tree.entries() {
        let value = value.map_err(|err| {
            JjError::Internal(format!("failed to read snapshot tree entry: {err}"))
        })?;
        let relative = path.as_internal_file_string();
        if strict
            && relative
                .split('/')
                .any(|part| part.eq_ignore_ascii_case(".git") || part.eq_ignore_ascii_case(".jj"))
        {
            return Err(JjError::BadRequest(format!(
                "repository metadata is not exportable source: {relative}"
            )));
        }
        let Some(resolved) = value.as_resolved() else {
            return Err(JjError::Conflict(format!(
                "cannot snapshot unresolved conflict at {relative}"
            )));
        };
        let target = path
            .to_fs_path(output)
            .map_err(|err| JjError::BadRequest(format!("invalid source path: {err}")))?;
        // Raw Git trees may contain duplicate names. A symlink yielded before a
        // same-named subtree must never become an ancestor of a later write.
        // Check the filesystem too, so case-folding aliases are covered.
        let mut parent = output.to_path_buf();
        let components: Vec<_> = target
            .strip_prefix(output)
            .map_err(|_| JjError::BadRequest("source path escaped snapshot output".into()))?
            .components()
            .collect();
        for component in components.iter().take(components.len().saturating_sub(1)) {
            parent.push(component);
            match std::fs::symlink_metadata(&parent) {
                Ok(metadata) if metadata.file_type().is_dir() => {}
                Ok(_) => {
                    return Err(JjError::BadRequest(format!(
                        "source parent is not a real directory: {relative}"
                    )))
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&parent).map_err(|err| {
                        JjError::Internal(format!("failed to create snapshot subdirectory: {err}"))
                    })?;
                }
                Err(err) => {
                    return Err(JjError::Internal(format!(
                        "failed to inspect source parent: {err}"
                    )))
                }
            }
        }
        match resolved {
            Some(TreeValue::File { id, executable, .. }) => {
                write_new_file_content_to(store.as_ref(), &path, id, &target).map_err(|err| {
                    JjError::Internal(format!("failed to write snapshot file: {err}"))
                })?;
                #[cfg(unix)]
                if *executable {
                    use std::os::unix::fs::PermissionsExt;
                    let mut permissions = std::fs::metadata(&target)
                        .map_err(|err| {
                            JjError::Internal(format!("failed to stat snapshot file: {err}"))
                        })?
                        .permissions();
                    permissions.set_mode(permissions.mode() | 0o111);
                    std::fs::set_permissions(&target, permissions).map_err(|err| {
                        JjError::Internal(format!("failed to set snapshot file mode: {err}"))
                    })?;
                }
                file_count += 1;
            }
            Some(TreeValue::Symlink(id)) => {
                let link = store.read_symlink(&path, id).block_on().map_err(|err| {
                    JjError::Internal(format!("failed to read snapshot symlink target: {err}"))
                })?;
                #[cfg(unix)]
                std::os::unix::fs::symlink(&link, &target).map_err(|err| {
                    JjError::Internal(format!("failed to write snapshot symlink: {err}"))
                })?;
                #[cfg(not(unix))]
                {
                    if strict {
                        return Err(JjError::BadRequest(
                            "native symlink export is unavailable on this platform".into(),
                        ));
                    }
                    use std::io::Write as _;
                    let mut file = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&target)
                        .map_err(|err| {
                            JjError::Internal(format!(
                                "failed to create snapshot symlink file: {err}"
                            ))
                        })?;
                    file.write_all(link.as_bytes()).map_err(|err| {
                        JjError::Internal(format!("failed to write snapshot symlink: {err}"))
                    })?;
                }
                file_count += 1;
            }
            Some(TreeValue::GitSubmodule(_)) if strict => {
                return Err(JjError::BadRequest(format!(
                    "submodule source is not materialized: {relative}"
                )))
            }
            Some(TreeValue::Tree(_)) | Some(TreeValue::GitSubmodule(_)) | None => {}
        }
    }
    Ok(file_count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jj_lib::{
        backend::CopyId,
        commit::Commit,
        conflict_labels::ConflictLabels,
        merge::Merge,
        repo::{ReadonlyRepo, Repo},
        repo_path::RepoPathBuf,
        tree_builder::TreeBuilder,
    };
    use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

    fn fixture() -> (tempfile::TempDir, PathBuf, Arc<ReadonlyRepo>) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repo");
        crate::init_repo(&root).unwrap();
        let (_, repo) =
            crate::jj_core::load_repo_at_head(&root, &create_settings(&UserConfig::default()))
                .unwrap();
        (directory, root, repo)
    }

    fn tree(repo: &Arc<ReadonlyRepo>, files: &[(&str, &[u8], bool)]) -> MergedTree {
        let store = repo.store();
        let mut builder = TreeBuilder::new(store.clone(), store.empty_tree_id().clone());
        for (path, bytes, executable) in files {
            let path = RepoPathBuf::from_internal_string(*path).unwrap();
            let mut reader = *bytes;
            let id = store.write_file(&path, &mut reader).block_on().unwrap();
            builder.set(
                path,
                TreeValue::File {
                    id,
                    executable: *executable,
                    copy_id: CopyId::placeholder(),
                },
            );
        }
        MergedTree::resolved(store.clone(), builder.write_tree().block_on().unwrap())
    }

    fn commit(repo: &Arc<ReadonlyRepo>, tree: MergedTree) -> Commit {
        let mut tx = repo.start_transaction();
        let commit = tx
            .repo_mut()
            .new_commit(vec![repo.store().root_commit_id().clone()], tree)
            .write()
            .block_on()
            .unwrap();
        tx.commit("export test fixture").block_on().unwrap();
        commit
    }

    fn disk_state(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn visit(root: &Path, directory: &Path, state: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in std::fs::read_dir(directory).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    visit(root, &entry.path(), state);
                } else if entry.file_type().unwrap().is_file() {
                    state.insert(
                        entry.path().strip_prefix(root).unwrap().to_owned(),
                        std::fs::read(entry.path()).unwrap(),
                    );
                }
            }
        }
        let mut state = BTreeMap::new();
        visit(root, root, &mut state);
        state
    }

    #[cfg(unix)]
    #[test]
    fn immutable_export_preserves_bytes_modes_links_and_divergent_operation_heads() {
        use std::os::unix::fs::PermissionsExt;
        let (directory, root, repo) = fixture();
        let initial_tree = tree(
            &repo,
            &[
                ("src/file", b"original\0bytes", false),
                ("check.sh", b"#!/bin/sh\nexit 0\n", true),
            ],
        );
        let mut builder = TreeBuilder::new(
            repo.store().clone(),
            initial_tree.tree_ids().as_resolved().unwrap().clone(),
        );
        let link_path = RepoPathBuf::from_internal_string("alias").unwrap();
        let link_id = repo
            .store()
            .write_symlink(&link_path, "src/file")
            .block_on()
            .unwrap();
        builder.set(link_path, TreeValue::Symlink(link_id));
        let old = commit(
            &repo,
            MergedTree::resolved(
                repo.store().clone(),
                builder.write_tree().block_on().unwrap(),
            ),
        );
        let (_, current) =
            crate::jj_core::load_repo_at_head(&root, &create_settings(&UserConfig::default()))
                .unwrap();
        // Two operations from the same base deliberately leave divergent heads.
        for content in [b"new-a".as_slice(), b"new-b".as_slice()] {
            let mut tx = current.start_transaction();
            let rewritten = tx
                .repo_mut()
                .rewrite_commit(&old)
                .set_tree(tree(&current, &[("src/file", content, false)]))
                .write()
                .block_on()
                .unwrap();
            assert_eq!(rewritten.change_id(), old.change_id());
            tx.repo_mut().rebase_descendants().block_on().unwrap();
            tx.commit("concurrent rewrite").block_on().unwrap();
        }
        let mut before_heads = current.op_heads_store().get_op_heads().block_on().unwrap();
        before_heads.sort();
        assert_eq!(before_heads.len(), 2);
        let before_working_copy = disk_state(&root.join(".jj/working_copy"));
        let parent = directory.path().join("checks");
        std::fs::create_dir(&parent).unwrap();
        let first = export_commit_tree(&root, &old.id().hex(), &parent).unwrap();
        let second = export_commit_tree(&root, &old.id().hex(), &parent).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(first.commit_id, old.id().hex());
        assert_eq!(first.change_id, old.change_id().reverse_hex());
        assert_eq!(
            first.tree_id,
            old.tree().tree_ids().as_resolved().unwrap().hex()
        );
        assert_eq!(first.file_count, 3);
        let output = Path::new(&first.path);
        assert!(output.starts_with(parent.canonicalize().unwrap()));
        assert_eq!(
            std::fs::metadata(output).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::read(output.join("src/file")).unwrap(),
            b"original\0bytes"
        );
        assert_eq!(
            std::fs::metadata(output.join("check.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0o111
        );
        assert_eq!(
            std::fs::metadata(output.join("src/file"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
        assert_eq!(
            std::fs::read_link(output.join("alias")).unwrap(),
            Path::new("src/file")
        );
        assert!(!output.join(".git").exists());
        assert!(!output.join(".jj").exists());
        let mut after_heads = current.op_heads_store().get_op_heads().block_on().unwrap();
        after_heads.sort();
        assert_eq!(before_heads, after_heads);
        assert_eq!(
            before_working_copy,
            disk_state(&root.join(".jj/working_copy"))
        );
    }

    #[test]
    fn invalid_ids_and_unsupported_trees_leave_no_partial_exports() {
        let (directory, root, repo) = fixture();
        let parent = directory.path().join("checks");
        std::fs::create_dir(&parent).unwrap();
        let clean = commit(&repo, tree(&repo, &[("ok", b"hello", false)]));
        for invalid in [
            clean.id().hex()[..12].to_owned(),
            clean.change_id().reverse_hex(),
            clean.id().hex().to_uppercase(),
            "f".repeat(clean.id().hex().len()),
        ] {
            assert!(
                export_commit_tree(&root, &invalid, &parent).is_err(),
                "{invalid}"
            );
        }
        for metadata in [".git/config", "nested/.JJ/state"] {
            let invalid = commit(
                &repo,
                tree(
                    &repo,
                    &[
                        ("a-written-first", b"partial", false),
                        (metadata, b"secret", false),
                    ],
                ),
            );
            assert!(export_commit_tree(&root, &invalid.id().hex(), &parent)
                .unwrap_err()
                .to_string()
                .contains("metadata"));
            assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);
        }
        let mut builder =
            TreeBuilder::new(repo.store().clone(), repo.store().empty_tree_id().clone());
        builder.set(
            RepoPathBuf::from_internal_string("vendor").unwrap(),
            TreeValue::GitSubmodule(clean.id().clone()),
        );
        let submodule = commit(
            &repo,
            MergedTree::resolved(
                repo.store().clone(),
                builder.write_tree().block_on().unwrap(),
            ),
        );
        assert!(export_commit_tree(&root, &submodule.id().hex(), &parent)
            .unwrap_err()
            .to_string()
            .contains("submodule"));
        let left = tree(&repo, &[("conflict", b"left", false)]);
        let right = tree(&repo, &[("conflict", b"right", false)]);
        let conflict = commit(
            &repo,
            MergedTree::new(
                repo.store().clone(),
                Merge::from_removes_adds(
                    [repo.store().empty_tree_id().clone()],
                    [
                        left.tree_ids().as_resolved().unwrap().clone(),
                        right.tree_ids().as_resolved().unwrap().clone(),
                    ],
                ),
                ConflictLabels::unlabeled(),
            ),
        );
        assert!(export_commit_tree(&root, &conflict.id().hex(), &parent)
            .unwrap_err()
            .to_string()
            .contains("unresolved"));
        assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);
    }

    #[test]
    fn raw_git_parent_path_cannot_escape_export_or_legacy_snapshot() {
        let (directory, root, repo) = fixture();
        let clean = commit(&repo, tree(&repo, &[("ok", b"hello", false)]));
        // Valid JJ paths cannot construct this input. A raw Git tree can:
        // its backend validates slashes/empty names but admits a literal '..'.
        let git = gix::open(root.join(".jj/repo/store/git")).unwrap();
        let blob = git.write_blob(b"outside write").unwrap().detach();
        let child = git
            .write_object(gix::objs::Tree {
                entries: vec![gix::objs::tree::Entry {
                    mode: gix::objs::tree::EntryKind::Blob.into(),
                    filename: "escaped".into(),
                    oid: blob,
                }],
            })
            .unwrap()
            .detach();
        let malicious_tree = git
            .write_object(gix::objs::Tree {
                entries: vec![gix::objs::tree::Entry {
                    mode: gix::objs::tree::EntryKind::Tree.into(),
                    filename: "..".into(),
                    oid: child,
                }],
            })
            .unwrap()
            .detach();
        let object = git
            .find_object(gix::ObjectId::from_hex(clean.id().hex().as_bytes()).unwrap())
            .unwrap()
            .into_commit();
        let mut raw_commit = object.decode().unwrap().to_owned().unwrap();
        raw_commit.tree = malicious_tree;
        let malicious = git.write_object(raw_commit).unwrap().detach();
        let parent = directory.path().join("checks");
        std::fs::create_dir(&parent).unwrap();
        let before_heads = repo.op_heads_store().get_op_heads().block_on().unwrap();
        let error = export_commit_tree(&root, &malicious.to_string(), &parent).unwrap_err();
        assert!(error.to_string().contains("invalid source path"), "{error}");
        assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);
        assert_eq!(
            before_heads,
            repo.op_heads_store().get_op_heads().block_on().unwrap()
        );
        // The shared older snapshot path gets the same filesystem guard.
        let bad = repo
            .store()
            .get_commit(&CommitId::try_from_hex(malicious.to_string()).unwrap())
            .unwrap();
        let output = parent.join("legacy");
        std::fs::create_dir(&output).unwrap();
        assert!(matches!(
            materialize(&bad.tree(), &output, false),
            Err(JjError::BadRequest(_))
        ));
        assert!(!parent.join("escaped").exists());
        assert_eq!(std::fs::read_dir(&output).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn existing_symlinks_cannot_redirect_snapshot_writes() {
        let (directory, _, repo) = fixture();
        let output = directory.path().join("snapshot");
        std::fs::create_dir(&output).unwrap();
        let outside = directory.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let marker = outside.join("file");
        std::fs::write(&marker, b"untouched").unwrap();
        std::os::unix::fs::symlink(&outside, output.join("parent")).unwrap();
        std::os::unix::fs::symlink(&marker, output.join("file")).unwrap();
        for strict in [false, true] {
            for path in ["parent/file", "file"] {
                assert!(materialize(
                    &tree(&repo, &[(path, b"replacement", false)]),
                    &output,
                    strict
                )
                .is_err());
                assert_eq!(std::fs::read(&marker).unwrap(), b"untouched");
            }
        }
    }

    // jj-lib rejects duplicate names with a debug assertion. Production builds
    // still need the filesystem guard; run this case with `cargo test --release`.
    #[cfg(all(unix, not(debug_assertions)))]
    #[test]
    fn duplicate_raw_tree_names_cannot_follow_previously_written_symlinks() {
        let (directory, root, repo) = fixture();
        let clean = commit(&repo, tree(&repo, &[("ok", b"hello", false)]));
        let git = gix::open(root.join(".jj/repo/store/git")).unwrap();
        let parent = directory.path().join("checks");
        std::fs::create_dir(&parent).unwrap();
        let marker = parent.join("outside-file");
        std::fs::write(&marker, b"untouched").unwrap();
        let contents = git.write_blob(b"replacement").unwrap().detach();
        for subtree in [true, false] {
            let link = git
                .write_blob(if subtree {
                    b"..".as_slice()
                } else {
                    b"../outside-file".as_slice()
                })
                .unwrap()
                .detach();
            let (mode, oid) = if subtree {
                (
                    gix::objs::tree::EntryKind::Tree,
                    git.write_object(gix::objs::Tree {
                        entries: vec![gix::objs::tree::Entry {
                            mode: gix::objs::tree::EntryKind::Blob.into(),
                            filename: "escaped".into(),
                            oid: contents,
                        }],
                    })
                    .unwrap()
                    .detach(),
                )
            } else {
                (gix::objs::tree::EntryKind::Blob, contents)
            };
            let malformed = git
                .write_object(gix::objs::Tree {
                    entries: vec![
                        gix::objs::tree::Entry {
                            mode: gix::objs::tree::EntryKind::Link.into(),
                            filename: "a".into(),
                            oid: link,
                        },
                        gix::objs::tree::Entry {
                            mode: mode.into(),
                            filename: "a".into(),
                            oid,
                        },
                    ],
                })
                .unwrap()
                .detach();
            let object = git
                .find_object(gix::ObjectId::from_hex(clean.id().hex().as_bytes()).unwrap())
                .unwrap()
                .into_commit();
            let mut raw = object.decode().unwrap().to_owned().unwrap();
            raw.tree = malformed;
            let id = git.write_object(raw).unwrap().detach();
            assert!(export_commit_tree(&root, &id.to_string(), &parent).is_err());
            assert!(!parent.join("escaped").exists());
            assert_eq!(std::fs::read(&marker).unwrap(), b"untouched");
            assert_eq!(
                std::fs::read_dir(&parent).unwrap().count(),
                1,
                "failed exports must leave no partial directory"
            );
        }
    }
}
