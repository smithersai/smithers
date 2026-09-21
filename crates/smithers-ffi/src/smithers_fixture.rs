use std::path::Path;

use jj_lib::backend::{CopyId, TreeValue};
use jj_lib::git::{
    self, GitProgress, GitPushOptions, GitRefUpdate, GitSidebandLineTerminator,
    GitSubprocessCallback, GitSubprocessOptions,
};
use jj_lib::git_backend::GitBackend;
use jj_lib::merge::Diff;
use jj_lib::merged_tree::MergedTree;
use jj_lib::object_id::ObjectId;
use jj_lib::op_store::RefTarget;
use jj_lib::ref_name::RefName;
use jj_lib::ref_name::WorkspaceName;
use jj_lib::repo::ReadonlyRepo;
use jj_lib::repo::Repo;
use jj_lib::repo_path::RepoPathBuf;
use jj_lib::tree_builder::TreeBuilder;
use jj_lib::workspace::Workspace;
use pollster::FutureExt as _;
use serde::Deserialize;
use serde_json::json;
use smithers_ffi::jj_core::{create_settings, load_repo_at_head, UserConfig};

#[derive(Deserialize)]
struct FileInput {
    path: String,
    content: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let command = args.next().ok_or("missing command")?;
    let repo_path = args.next().ok_or("missing repo_path")?;

    match command.as_str() {
        "publish-append-fixture" => {
            let guest = args.next().ok_or("missing guest path")?;
            let workspace_id = args.next().ok_or("missing workspace ID")?;
            publish_append_fixture(Path::new(&repo_path), Path::new(&guest), &workspace_id)
        }
        "create-commit" => {
            let description = args.next().ok_or("missing description")?;
            let files_json = args.next().ok_or("missing files JSON")?;
            let files: Vec<FileInput> = serde_json::from_str(&files_json)?;
            let file_pairs: Vec<(&str, &str)> = files
                .iter()
                .map(|f| (f.path.as_str(), f.content.as_str()))
                .collect();
            let change_id =
                create_commit_with_files(Path::new(&repo_path), &description, &file_pairs)?;
            println!("{}", json!({ "change_id": change_id }));
            Ok(())
        }
        "create-conflicted-change" => {
            let change_id = create_conflicted_change(Path::new(&repo_path))?;
            println!("{}", json!({ "change_id": change_id }));
            Ok(())
        }
        _ => Err(format!("unknown command: {command}").into()),
    }
}

fn create_conflicted_change(repo_path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    create_commit_with_files(repo_path, "base", &[("shared.txt", "base\n")])?;

    let settings = create_settings(&UserConfig::default());
    let (_, repo) = load_repo_at_head(repo_path, &settings)?;
    let base_id = repo
        .view()
        .get_wc_commit_id(WorkspaceName::DEFAULT)
        .ok_or("missing base wc id")?
        .clone();

    create_commit_with_files(repo_path, "main", &[("shared.txt", "main version\n")])?;

    let settings = create_settings(&UserConfig::default());
    let (_, repo) = load_repo_at_head(repo_path, &settings)?;
    let main_id = repo
        .view()
        .get_wc_commit_id(WorkspaceName::DEFAULT)
        .ok_or("missing main wc id")?
        .clone();

    let mut tx = repo.start_transaction();
    tx.repo_mut()
        .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), base_id)
        .map_err(|err| format!("reset wc to base: {err}"))?;
    tx.commit("reset wc to base").block_on()?;

    create_commit_with_files(repo_path, "feature", &[("shared.txt", "feature version\n")])?;

    let settings = create_settings(&UserConfig::default());
    let (_, repo) = load_repo_at_head(repo_path, &settings)?;
    let feature_id = repo
        .view()
        .get_wc_commit_id(WorkspaceName::DEFAULT)
        .ok_or("missing feature wc id")?
        .clone();

    let main_commit = repo.store().get_commit(&main_id)?;
    let feature_commit = repo.store().get_commit(&feature_id)?;
    let merged_tree =
        jj_lib::rewrite::merge_commit_trees(repo.as_ref(), &[main_commit, feature_commit])
            .block_on()?;
    if !merged_tree.has_conflict() {
        return Err("expected conflicted merge tree".into());
    }

    let mut tx = repo.start_transaction();
    let merge_commit = tx
        .repo_mut()
        .new_commit(vec![main_id, feature_id], merged_tree)
        .set_description("conflicted merge")
        .write()
        .block_on()?;
    tx.repo_mut()
        .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), merge_commit.id().clone())
        .map_err(|err| format!("set merge wc: {err}"))?;
    let repo = tx.commit("commit conflicted merge").block_on()?;

    let merge_id = repo
        .view()
        .get_wc_commit_id(WorkspaceName::DEFAULT)
        .ok_or("missing merge wc id")?
        .clone();
    Ok(repo
        .store()
        .get_commit(&merge_id)?
        .change_id()
        .reverse_hex())
}

fn create_commit_with_files(
    repo_path: &Path,
    description: &str,
    files: &[(&str, &str)],
) -> Result<String, Box<dyn std::error::Error>> {
    let settings = create_settings(&UserConfig::default());
    let (_, repo) = load_repo_at_head(repo_path, &settings)?;
    let store = repo.store();
    let wc_id = repo
        .view()
        .get_wc_commit_id(WorkspaceName::DEFAULT)
        .ok_or("missing working-copy commit")?
        .clone();
    let parent_commit = store.get_commit(&wc_id)?;
    let parent_tree_id = parent_commit
        .tree()
        .tree_ids()
        .clone()
        .into_resolved()
        .map_err(|_| "unresolved parent tree")?
        .clone();

    let mut tree_builder = TreeBuilder::new(store.clone(), parent_tree_id);
    for (path, content) in files {
        let path = RepoPathBuf::from_internal_string(*path)?;
        let file_id = store
            .write_file(&path, &mut content.as_bytes())
            .block_on()?;
        tree_builder.set(
            path,
            TreeValue::File {
                id: file_id,
                executable: false,
                copy_id: CopyId::placeholder(),
            },
        );
    }

    let tree = MergedTree::resolved(store.clone(), tree_builder.write_tree().block_on()?);
    let mut tx = repo.start_transaction();
    let commit = tx
        .repo_mut()
        .new_commit(vec![wc_id], tree)
        .set_description(description)
        .write()
        .block_on()?;
    tx.repo_mut()
        .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), commit.id().clone())
        .map_err(|err| format!("set wc commit: {err}"))?;
    let repo = tx.commit("fixture commit").block_on()?;

    let commit_id = repo
        .view()
        .get_wc_commit_id(WorkspaceName::DEFAULT)
        .ok_or("missing committed wc id")?
        .clone();
    Ok(repo
        .store()
        .get_commit(&commit_id)?
        .change_id()
        .reverse_hex())
}

// Integration-only native guest transport. The production publisher exercises
// its credential/HTTP ACK path separately; no fixture credentials are needed.
struct Quiet;
impl GitSubprocessCallback for Quiet {
    fn needs_progress(&self) -> bool {
        false
    }
    fn progress(&mut self, _: &GitProgress) -> std::io::Result<()> {
        Ok(())
    }
    fn local_sideband(
        &mut self,
        _: &[u8],
        _: Option<GitSidebandLineTerminator>,
    ) -> std::io::Result<()> {
        Ok(())
    }
    fn remote_sideband(
        &mut self,
        _: &[u8],
        _: Option<GitSidebandLineTerminator>,
    ) -> std::io::Result<()> {
        Ok(())
    }
}
fn native_source(repo: &ReadonlyRepo) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let id = repo
        .view()
        .get_wc_commit_id(WorkspaceName::DEFAULT)
        .ok_or("working copy missing")?;
    let commit = repo.store().get_commit(id)?;
    let tree = commit
        .tree()
        .tree_ids()
        .clone()
        .into_resolved()
        .map_err(|_| "conflicted source")?;
    Ok(
        json!({"change_id":commit.change_id().reverse_hex(),"commit_id":id.hex(),"tree_id":tree.hex(),"parent_commit_ids":commit.parent_ids().iter().map(ObjectId::hex).collect::<Vec<_>>()}),
    )
}
fn fixture_push(
    repo: &ReadonlyRepo,
    workspace: &str,
    source: &serde_json::Value,
) -> Result<(), Box<dyn std::error::Error>> {
    let id = source["commit_id"].as_str().ok_or("source missing")?;
    let update = GitRefUpdate {
        qualified_name: format!("refs/smithers/workspaces/{workspace}/sources/{id}").into(),
        targets: Diff {
            before: None,
            after: Some(gix::ObjectId::from_hex(id.as_bytes())?),
        },
    };
    git::push_updates(
        repo,
        GitSubprocessOptions::from_settings(repo.settings())?,
        "origin".as_ref(),
        &[update],
        &mut Quiet,
        &GitPushOptions::default(),
    )?;
    Ok(())
}
fn publish_append_fixture(
    cloud: &Path,
    guest: &Path,
    workspace: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let settings = create_settings(&UserConfig::default());
    let (_, cloud_repo) = load_repo_at_head(cloud, &settings)?;
    let initial = native_source(&cloud_repo)?;
    let main = cloud_repo
        .view()
        .get_wc_commit_id(WorkspaceName::DEFAULT)
        .ok_or("main missing")?
        .clone();
    let url = cloud_repo
        .store()
        .backend_impl::<GitBackend>()
        .ok_or("git backend missing")?
        .git_repo()
        .path()
        .to_str()
        .ok_or("bad backend path")?
        .to_owned();
    let mut tx = cloud_repo.start_transaction();
    tx.repo_mut()
        .set_local_bookmark_target(RefName::new("main"), RefTarget::normal(main));
    tx.commit("fixture main").block_on()?;
    std::fs::create_dir_all(guest)?;
    Workspace::init_internal_git(&settings, guest, gix::hash::Kind::Sha1).block_on()?;
    let (_, repo) = load_repo_at_head(guest, &settings)?;
    let mut tx = repo.start_transaction();
    git::add_remote(tx.repo_mut(), "origin".as_ref(), &url, None)?;
    let repo = tx.commit("fixture origin").block_on()?;
    let source_base = native_source(&repo)?;
    fixture_push(&repo, workspace, &source_base)?;
    create_commit_with_files(guest, "first", &[("src/a.txt", "first")])?;
    create_commit_with_files(guest, "second", &[("src/b.txt", "second")])?;
    let (_, repo) = load_repo_at_head(guest, &settings)?;
    let source = native_source(&repo)?;
    fixture_push(&repo, workspace, &source)?;
    println!(
        "{}",
        json!({"main":initial,"source_base":source_base,"source":source})
    );
    Ok(())
}
