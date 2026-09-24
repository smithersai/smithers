//! The flows `Jj` contract ops implemented over jj-lib.
//!
//! Semantics mirror `NodeJj` (`packages/jj/src/node/NodeJj.ts`), which shells
//! out to the `jj` CLI; each function here is the jj-lib equivalent of the
//! CLI invocation the Node layer performs. Repos use jj's `SimpleBackend`
//! (`jj debug init-simple` compatible) — git interop is out of scope.
//!
//! jj-lib's store traits are async but never pend over a synchronous
//! filesystem, so futures are driven with `pollster::block_on`, the same way
//! jj-lib's own sync wrappers (e.g. `Store::get_commit`) do.

use std::path::Path;
use std::sync::Arc;

use jj_lib::commit::Commit;
use jj_lib::config::ConfigLayer;
use jj_lib::config::ConfigSource;
use jj_lib::config::StackedConfig;
use jj_lib::default_backend_factories::default_backend_factories;
use jj_lib::default_backend_factories::default_working_copy_factories;
use jj_lib::default_backend_factories::default_working_copy_factory;
use jj_lib::file_util;
use jj_lib::gitignore::GitIgnoreFile;
use jj_lib::matchers::EverythingMatcher;
use jj_lib::matchers::NothingMatcher;
use jj_lib::object_id::HexPrefix;
use jj_lib::object_id::ObjectId as _;
use jj_lib::object_id::PrefixResolution;
use jj_lib::ref_name::WorkspaceName;
use jj_lib::ref_name::WorkspaceNameBuf;
use jj_lib::repo::ReadonlyRepo;
use jj_lib::repo::Repo as _;
use jj_lib::rewrite::merge_commit_trees;
use jj_lib::settings::UserSettings;
use jj_lib::working_copy::SnapshotOptions;
use jj_lib::working_copy::WorkingCopyFreshness;
use jj_lib::workspace::Workspace;
use jj_lib::workspace_store::SimpleWorkspaceStore;
use jj_lib::workspace_store::WorkspaceStore as _;
use pollster::FutureExt as _;

use crate::diff_render;
use crate::error::OpError;
use crate::status_render;

/// `change_id.short()` in jj's template language truncates the reverse-hex
/// change id to 12 characters; `NodeJj` reads ids with exactly that template.
const SHORT_CHANGE_ID_LEN: usize = 12;

/// The identity recorded on commits and operations. The browser has no
/// `$USER`/`$HOSTNAME`; these are deliberately fixed so snapshots are
/// deterministic in what they depend on.
const USER_CONFIG: &str = r#"
user.name = "Flows"
user.email = "flows@localhost"
operation.hostname = "flows"
operation.username = "flows"
"#;

/// Immutable settings for every op. jj's config machinery stays out of the
/// wasm module — this is the whole configuration surface.
fn user_settings() -> Result<UserSettings, OpError> {
    let mut config = StackedConfig::with_defaults();
    let layer = ConfigLayer::parse(ConfigSource::User, USER_CONFIG)?;
    config.add_layer(layer);
    Ok(UserSettings::from_config(config)?)
}

/// Snapshot options matching jj's defaults for a repo with no user config:
/// track everything, no base ignores beyond in-tree `.gitignore` files, no
/// file-size ceiling.
fn snapshot_options() -> SnapshotOptions<'static> {
    SnapshotOptions {
        base_ignores: GitIgnoreFile::empty(),
        progress: None,
        start_tracking_matcher: &EverythingMatcher,
        force_tracking_matcher: &NothingMatcher,
        max_new_file_size: u64::MAX,
    }
}

/// Loads an existing workspace without creating directories or repository state.
fn load(settings: &UserSettings, root: &Path) -> Result<(Workspace, Arc<ReadonlyRepo>), OpError> {
    let workspace = Workspace::load(
        settings,
        root,
        &default_backend_factories(),
        &default_working_copy_factories(),
    )?;
    let repo_loader = workspace.repo_loader().clone();
    let repo = repo_loader.load_at_head().block_on()?;
    Ok((workspace, repo))
}

/// The workspace's current working-copy commit according to `repo`'s view.
fn wc_commit(repo: &Arc<ReadonlyRepo>, name: &WorkspaceName) -> Result<Commit, OpError> {
    let commit_id = repo.view().get_wc_commit_id(name).ok_or_else(|| {
        OpError::unknown(format!(
            "workspace '{name}' has no working-copy commit (forgotten?)",
            name = name.as_symbol()
        ))
    })?;
    Ok(repo.store().get_commit(commit_id)?)
}

/// Snapshots the working copy into the current change and commits the
/// "snapshot working copy" operation, mirroring what every `jj` CLI command
/// does before running. Returns the (possibly rewritten) working-copy commit.
fn snapshot_working_copy(
    workspace: &mut Workspace,
    repo: &mut Arc<ReadonlyRepo>,
) -> Result<Commit, OpError> {
    let name = workspace.workspace_name().to_owned();
    let mut locked_ws = workspace.start_working_copy_mutation().block_on()?;
    let mut commit = wc_commit(repo, &name)?;
    match WorkingCopyFreshness::check_stale(locked_ws.locked_wc(), &commit, repo).block_on()? {
        WorkingCopyFreshness::Fresh => {}
        WorkingCopyFreshness::Updated(operation) => {
            *repo = repo.reload_at(&operation).block_on()?;
            commit = wc_commit(repo, &name)?;
        }
        WorkingCopyFreshness::WorkingCopyStale | WorkingCopyFreshness::SiblingOperation => {
            return Err(OpError::unknown(format!(
                "the working copy at '{root}' is stale (not updated since an older operation)",
                root = workspace.workspace_root().display()
            )));
        }
    }
    let options = snapshot_options();
    let (new_tree, _stats) = locked_ws.locked_wc().snapshot(&options).block_on()?;
    if new_tree.tree_ids_and_labels() != commit.tree().tree_ids_and_labels() {
        let mut tx = repo.start_transaction();
        tx.set_is_snapshot(true);
        let mut_repo = tx.repo_mut();
        let new_commit = mut_repo
            .rewrite_commit(&commit)
            .set_tree(new_tree)
            .write()
            .block_on()?;
        mut_repo.set_wc_commit(name.clone(), new_commit.id().clone())?;
        mut_repo.rebase_descendants().block_on()?;
        *repo = tx.commit("snapshot working copy").block_on()?;
        commit = new_commit;
    }
    locked_ws.finish(repo.op_id().clone()).block_on()?;
    Ok(commit)
}

/// Resolves a user-supplied revision string to a commit: `@` is the
/// working-copy commit, otherwise a change-id prefix (reverse hex, the form
/// `snapshot` returns) or a commit-id prefix (hex). Every failure is
/// `invalid_ref` — the messages reuse jj's own stderr vocabulary so the two
/// `Jj` layers classify identically.
fn resolve_revision(
    repo: &Arc<ReadonlyRepo>,
    workspace_commit: &Commit,
    symbol: &str,
) -> Result<Commit, OpError> {
    if symbol == "@" {
        return Ok(workspace_commit.clone());
    }
    if symbol.is_empty() {
        return Err(OpError::invalid_ref("empty revision string"));
    }
    if let Some(prefix) = HexPrefix::try_from_reverse_hex(symbol) {
        match repo.resolve_change_id_prefix(&prefix)? {
            PrefixResolution::NoMatch => {}
            PrefixResolution::AmbiguousMatch => {
                return Err(OpError::invalid_ref(format!(
                    "change id prefix \"{symbol}\" is ambiguous"
                )));
            }
            PrefixResolution::SingleMatch(targets) => {
                let visible: Vec<_> = targets
                    .visible_with_offsets()
                    .map(|(_offset, commit_id)| commit_id)
                    .collect();
                return match visible[..] {
                    [] => Err(OpError::invalid_ref(format!(
                        "revision \"{symbol}\" doesn't exist (the change is hidden)"
                    ))),
                    [commit_id] => Ok(repo.store().get_commit(commit_id)?),
                    _ => Err(OpError::invalid_ref(format!(
                        "change id \"{symbol}\" is divergent"
                    ))),
                };
            }
        }
    }
    if let Some(prefix) = HexPrefix::try_from_hex(symbol) {
        match repo.index().resolve_commit_id_prefix(&prefix)? {
            PrefixResolution::NoMatch => {}
            PrefixResolution::AmbiguousMatch => {
                return Err(OpError::invalid_ref(format!(
                    "commit id prefix \"{symbol}\" is ambiguous"
                )));
            }
            PrefixResolution::SingleMatch(commit_id) => {
                return Ok(repo.store().get_commit(&commit_id)?);
            }
        }
    }
    Err(OpError::invalid_ref(format!(
        "revision \"{symbol}\" doesn't exist"
    )))
}

/// The first 12 characters of the reverse-hex change id — the exact string
/// `NodeJj` reads with `-T "change_id.short()"`.
fn short_change_id(commit: &Commit) -> String {
    let mut id = commit.change_id().reverse_hex();
    id.truncate(SHORT_CHANGE_ID_LEN);
    id
}

/// `init`: create a `SimpleBackend` repo at `root`. Idempotent — an existing
/// workspace is loaded (validated) and left untouched, so a reloading page
/// can call `init` unconditionally.
pub fn init(root: &Path) -> Result<(), OpError> {
    let settings = user_settings()?;
    if root.join(".jj").exists() {
        let _ = load(&settings, root)?;
    } else {
        std::fs::create_dir_all(root)?;
        Workspace::init_simple(&settings, root).block_on()?;
    }
    Ok(())
}

/// The CLOSED change a [`snapshot`] recorded.
///
/// `commit_id` is the restore pointer: a full hex commit id is content
/// addressed, so no later rewrite (a `squash` into it, a `describe`, an
/// `abandon`) can change the tree it names, and jj still resolves it once the
/// commit is hidden. `change_id` is the change's human identity; a rewrite
/// moves it to the new commit, so it is display metadata only.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Snapshot {
    pub commit_id: String,
    pub change_id: String,
}

/// `snapshot`: describe the current change (setting `message` when given),
/// remember its commit id and short change id, then open a fresh empty change
/// on top — `jj describe [-m message] --quiet && jj new --quiet`. Returns the
/// CLOSED commit: the state callers later `restore` to.
pub fn snapshot(root: &Path, message: Option<&str>) -> Result<Snapshot, OpError> {
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    let name = workspace.workspace_name().to_owned();
    let mut commit = snapshot_working_copy(&mut workspace, &mut repo)?;

    if let Some(message) = message
        && commit.description() != message
    {
        let mut tx = repo.start_transaction();
        let mut_repo = tx.repo_mut();
        mut_repo
            .rewrite_commit(&commit)
            .set_description(message)
            .write()
            .block_on()?;
        mut_repo.rebase_descendants().block_on()?;
        repo = tx
            .commit(format!("describe commit {}", commit.id().hex()))
            .block_on()?;
        commit = wc_commit(&repo, &name)?;
    }

    let closed = Snapshot {
        commit_id: commit.id().hex(),
        change_id: short_change_id(&commit),
    };

    let mut tx = repo.start_transaction();
    let mut_repo = tx.repo_mut();
    let new_commit = mut_repo
        .new_commit(vec![commit.id().clone()], commit.tree())
        .write()
        .block_on()?;
    mut_repo.edit(name, &new_commit).block_on()?;
    // `edit` may abandon the previous working-copy commit; transactions
    // assert that any such rewrite has been propagated before committing.
    mut_repo.rebase_descendants().block_on()?;
    repo = tx.commit("new empty commit").block_on()?;
    let old_tree = commit.tree();
    workspace
        .check_out(repo.op_id().clone(), Some(&old_tree), &new_commit)
        .block_on()?;

    Ok(closed)
}

/// `restore`: put the working-copy files back to `change_id`'s tree —
/// `jj restore --from <change_id>`. The current change keeps its identity;
/// only its tree (and the files on disk) change.
pub fn restore(root: &Path, change_id: &str) -> Result<(), OpError> {
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    let name = workspace.workspace_name().to_owned();
    let commit = snapshot_working_copy(&mut workspace, &mut repo)?;
    let from_commit = resolve_revision(&repo, &commit, change_id)?;
    if from_commit.tree_ids() == commit.tree_ids() {
        return Ok(());
    }
    let mut tx = repo.start_transaction();
    let mut_repo = tx.repo_mut();
    mut_repo
        .rewrite_commit(&commit)
        .set_tree(from_commit.tree())
        .write()
        .block_on()?;
    mut_repo.rebase_descendants().block_on()?;
    repo = tx
        .commit(format!("restore into commit {}", commit.id().hex()))
        .block_on()?;
    let new_commit = wc_commit(&repo, &name)?;
    let old_tree = commit.tree();
    workspace
        .check_out(repo.op_id().clone(), Some(&old_tree), &new_commit)
        .block_on()?;
    Ok(())
}

/// `diff`: git-format unified diff between two revisions' trees —
/// `jj diff --from <from> --to <to> --git`.
pub fn diff(root: &Path, from: &str, to: &str) -> Result<String, OpError> {
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    let commit = snapshot_working_copy(&mut workspace, &mut repo)?;
    let from_commit = resolve_revision(&repo, &commit, from)?;
    let to_commit = resolve_revision(&repo, &commit, to)?;
    diff_render::git_diff(repo.store(), &from_commit.tree(), &to_commit.tree())
}

/// `status`: current change id plus per-file working-copy changes (A/M/D
/// lines) — `jj status`. Contract callers treat the text as opaque; the
/// format is ours and covered by tests.
pub fn status(root: &Path) -> Result<String, OpError> {
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    let commit = snapshot_working_copy(&mut workspace, &mut repo)?;
    let parent_tree = commit.parent_tree(repo.as_ref()).block_on()?;
    status_render::status(&parent_tree, &commit.tree(), &short_change_id(&commit))
}

/// `workspaceAdd`: attach a second working copy named `name` at `path` —
/// `jj workspace add --name <name> <path>`. The new workspace's working-copy
/// commit is opened on the parents of this workspace's current change, same
/// as the CLI.
pub fn workspace_add(root: &Path, name: &str, path: &str) -> Result<(), OpError> {
    let settings = user_settings()?;
    let (mut workspace, mut repo) = load(&settings, root)?;
    snapshot_working_copy(&mut workspace, &mut repo)?;

    if name.is_empty() {
        return Err(OpError::unknown("workspace name cannot be empty"));
    }
    let name_buf: WorkspaceNameBuf = name.into();
    if repo.view().get_wc_commit_id(&name_buf).is_some() {
        return Err(OpError::unknown(format!(
            "workspace '{name}' already exists"
        )));
    }
    let destination = Path::new(path);
    if !destination.exists() {
        std::fs::create_dir_all(destination)?;
    } else if !file_util::is_empty_dir(destination)? {
        return Err(OpError::unknown(format!(
            "destination path '{path}' exists and is not an empty directory"
        )));
    }

    let (mut new_workspace, repo) = Workspace::init_workspace_with_existing_repo(
        destination,
        workspace.repo_path(),
        &repo,
        &*default_working_copy_factory(),
        name_buf.clone(),
    )
    .block_on()?;

    let parents = match repo.view().get_wc_commit_id(workspace.workspace_name()) {
        Some(commit_id) => repo.store().get_commit(commit_id)?.parents().block_on()?,
        None => vec![repo.store().root_commit()],
    };
    let mut tx = repo.start_transaction();
    let merged_tree = merge_commit_trees(tx.repo(), &parents).block_on()?;
    let parent_ids = parents.iter().map(|commit| commit.id().clone()).collect();
    let mut_repo = tx.repo_mut();
    let new_commit = mut_repo
        .new_commit(parent_ids, merged_tree)
        .write()
        .block_on()?;
    mut_repo.edit(name_buf, &new_commit).block_on()?;
    // `edit` abandons the placeholder commit the workspace was initialized
    // with; the abandonment must be propagated before the transaction commits.
    mut_repo.rebase_descendants().block_on()?;
    let repo = tx
        .commit(format!(
            "create initial working-copy commit in workspace {name}"
        ))
        .block_on()?;
    new_workspace
        .check_out(repo.op_id().clone(), None, &new_commit)
        .block_on()?;
    Ok(())
}

/// `workspaceForget`: stop tracking workspace `name` —
/// `jj workspace forget <name>`. Forgetting a workspace that does not exist
/// is a no-op, exactly like the CLI (which warns and exits 0). The files at
/// the forgotten workspace's path are left in place, also like the CLI.
pub fn workspace_forget(root: &Path, name: &str) -> Result<(), OpError> {
    let settings = user_settings()?;
    let (workspace, repo) = load(&settings, root)?;
    let name_buf: WorkspaceNameBuf = name.into();
    if repo.view().get_wc_commit_id(&name_buf).is_none() {
        return Ok(());
    }
    let mut tx = repo.start_transaction();
    let mut_repo = tx.repo_mut();
    mut_repo.remove_wc_commit(&name_buf).block_on()?;
    // Removing the working-copy commit may abandon it (a rewrite), which must
    // be propagated before the transaction commits.
    mut_repo.rebase_descendants().block_on()?;
    let workspace_store = SimpleWorkspaceStore::load(workspace.repo_path())?;
    workspace_store.forget(&[&*name_buf])?;
    tx.commit(format!("forget workspace {name}")).block_on()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_repository_operations_do_not_create_a_directory() {
        let temp = tempfile::tempdir().unwrap();
        for exists in [false, true] {
            let root = temp.path().join(if exists { "empty" } else { "missing" });
            if exists {
                std::fs::create_dir(&root).unwrap();
            }
            for result in [
                status(&root),
                diff(&root, "@", "@"),
                restore(&root, "@").map(|()| String::new()),
            ] {
                assert!(result.is_err());
                assert_eq!(result.unwrap_err().code, crate::error::ErrorCode::Unknown);
                assert_eq!(root.exists(), exists);
                assert!(!root.join(".jj").exists());
            }
        }
    }
}
