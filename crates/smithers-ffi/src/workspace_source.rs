//! Immutable workspace source refs retain the original history independently
//! of the live head and JJ operation-log GC. Reading never imports a bookmark.
use jj_lib::backend::CommitId;
use jj_lib::git_backend::GitBackend;
use jj_lib::object_id::ObjectId;
use jj_lib::repo::{ReadonlyRepo, Repo};
use serde::{Deserialize, Serialize};

use crate::FfiError;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub change_id: String,
    pub commit_id: String,
    pub tree_id: String,
    pub parent_commit_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub workspace_id: String,
    pub source: Source,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Receipt {
    pub status: String,
    pub workspace_id: String,
    pub r#ref: String,
    pub source: Source,
}

pub fn full_id(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn source_ref(workspace: &str, commit: &str) -> anyhow::Result<String> {
    let valid = workspace.len() == 36
        && workspace.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        });
    anyhow::ensure!(
        valid
            && workspace != "00000000-0000-0000-0000-000000000000"
            && full_id(commit)
            && commit != "0000000000000000000000000000000000000000",
        "invalid workspace source identity"
    );
    Ok(format!(
        "refs/smithers/workspaces/{workspace}/sources/{commit}"
    ))
}

impl Source {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.change_id.len() == 32
                && self.change_id.bytes().all(|b| (b'k'..=b'z').contains(&b))
                && full_id(&self.commit_id)
                && full_id(&self.tree_id)
                && self.parent_commit_ids.len() <= 16
                && self.parent_commit_ids.iter().all(|id| full_id(id)),
            "invalid native source identity"
        );
        Ok(())
    }

    pub fn from_commit(commit: &jj_lib::commit::Commit) -> anyhow::Result<Self> {
        let tree = commit
            .tree()
            .tree_ids()
            .clone()
            .into_resolved()
            .map_err(|_| anyhow::anyhow!("source tree is conflicted"))?;
        Ok(Self {
            change_id: commit.change_id().reverse_hex(),
            commit_id: commit.id().hex(),
            tree_id: tree.hex(),
            parent_commit_ids: commit.parent_ids().iter().map(ObjectId::hex).collect(),
        })
    }
}

pub(crate) fn read(repo: &ReadonlyRepo, request: Request) -> Result<Receipt, FfiError> {
    request
        .source
        .validate()
        .map_err(|e| FfiError::BadRequest(e.to_string()))?;
    let name = source_ref(&request.workspace_id, &request.source.commit_id)
        .map_err(|e| FfiError::BadRequest(e.to_string()))?;
    let backend = repo.store().backend_impl::<GitBackend>().ok_or_else(|| {
        FfiError::Internal("workspace source requires the repository transport backend".into())
    })?;
    let git = backend.git_repo();
    let reference = git
        .try_find_reference(name.as_str())
        .map_err(|_| FfiError::Internal("could not read workspace source ref".into()))?
        .ok_or(FfiError::WorkspaceSourceMissing)?;
    let target = reference
        .try_id()
        .ok_or_else(|| FfiError::Conflict("workspace source ref must be direct".into()))?;
    if target.to_string() != request.source.commit_id {
        return Err(FfiError::Conflict(
            "workspace source ref target mismatch".into(),
        ));
    }
    let commit = repo
        .store()
        .get_commit(
            &CommitId::try_from_hex(&request.source.commit_id).expect("validated commit ID"),
        )
        .map_err(|_| FfiError::Internal("retained workspace source object unavailable".into()))?;
    let source = Source::from_commit(&commit)
        .map_err(|_| FfiError::Conflict("retained workspace source is conflicted".into()))?;
    if source != request.source {
        return Err(FfiError::Conflict(
            "retained workspace source identity mismatch".into(),
        ));
    }
    Ok(Receipt {
        status: "retained".into(),
        workspace_id: request.workspace_id,
        r#ref: name,
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jj_core::{create_settings, load_repo, UserConfig};
    use jj_lib::merged_tree::MergedTree;
    use jj_lib::workspace::Workspace;
    use pollster::FutureExt as _;

    #[test]
    fn source_pin_survives_abandonment_without_operation_or_bookmark_retention() {
        let temp = tempfile::TempDir::new().unwrap();
        let settings = create_settings(&UserConfig::default());
        Workspace::init_internal_git(&settings, temp.path(), gix::hash::Kind::Sha1)
            .block_on()
            .unwrap();
        let repo = load_repo(temp.path(), &settings).unwrap();
        let before = repo.operation().id().clone();
        // Model an uploaded historical source which was abandoned locally:
        // it has no cloud JJ operation/index/bookmark membership at all.
        let mut transaction = repo.start_transaction();
        let source_commit = transaction
            .repo_mut()
            .new_commit(
                vec![repo.store().root_commit_id().clone()],
                MergedTree::resolved(repo.store().clone(), repo.store().empty_tree_id().clone()),
            )
            .set_description("abandoned original source")
            .write()
            .block_on()
            .unwrap();
        let unpinned = transaction
            .repo_mut()
            .new_commit(
                vec![repo.store().root_commit_id().clone()],
                MergedTree::resolved(repo.store().clone(), repo.store().empty_tree_id().clone()),
            )
            .set_description("unretained control")
            .write()
            .block_on()
            .unwrap();
        drop(transaction);
        assert!(!repo.index().has_id(source_commit.id()).unwrap());
        assert!(!repo.index().has_id(unpinned.id()).unwrap());
        let source = Source::from_commit(&source_commit).unwrap();
        let workspace = "0f8fad5b-d9cb-469f-a165-70867728950e";
        let request = || Request {
            workspace_id: workspace.into(),
            source: source.clone(),
        };
        assert!(matches!(
            read(&repo, request()),
            Err(FfiError::WorkspaceSourceMissing)
        ));
        let backend = repo.store().backend_impl::<GitBackend>().unwrap();
        let name = source_ref(workspace, &source.commit_id).unwrap();
        backend
            .git_repo()
            .reference(
                name.as_str(),
                gix::ObjectId::from_bytes_or_panic(source_commit.id().as_bytes()),
                gix::refs::transaction::PreviousValue::MustNotExist,
                "retain original source",
            )
            .unwrap();
        let first = read(&repo, request()).unwrap();
        assert_eq!(read(&repo, request()).unwrap(), first);
        let mut wrong = request();
        wrong.workspace_id = "7c9e6679-7425-40de-944b-e07fc1f90ae7".into();
        assert!(matches!(
            read(&repo, wrong),
            Err(FfiError::WorkspaceSourceMissing)
        ));
        let mut wrong = request();
        wrong.source.tree_id = "a".repeat(40);
        assert!(matches!(read(&repo, wrong), Err(FfiError::Conflict(_))));
        // Remove transient JJ keep refs and prune every unindexed old object.
        repo.store()
            .gc(
                repo.index(),
                std::time::SystemTime::now() + std::time::Duration::from_secs(2),
            )
            .unwrap();
        let fresh = load_repo(temp.path(), &settings).unwrap();
        assert_eq!(fresh.operation().id(), &before);
        assert!(fresh.view().local_bookmarks().next().is_none());
        assert_eq!(read(&fresh, request()).unwrap(), first);
        assert!(fresh.store().get_commit(unpinned.id()).is_err(), "unretained control must be collected so this tests the pin, not incidental JJ history retention");
    }
}
