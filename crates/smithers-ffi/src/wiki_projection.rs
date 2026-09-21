//! Idempotent projection of accepted database revisions into the existing JJ
//! wiki sidecar. The caller holds the sidecar's existing repository write lock.
use super::*;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Revision {
    pub id: u64,
    pub page_id: u64,
    pub revision: u64,
    pub slug: String,
    pub title: String,
    pub body: String,
    pub author: String,
    pub deleted: bool,
}

fn read(
    repo: &ReadonlyRepo,
    commit: &jj_lib::commit::Commit,
    path: &RepoPathBuf,
) -> Result<Option<String>, JjError> {
    let value = commit
        .tree()
        .path_value(path)
        .block_on()
        .map_err(|e| JjError::Internal(format!("read wiki projection: {e}")))?;
    match value.as_resolved() {
        Some(Some(TreeValue::File { id, .. })) => {
            let data = repo
                .store()
                .read_file(path, id)
                .block_on()
                .map_err(|e| JjError::Internal(format!("read wiki projection blob: {e}")))?;
            use futures::AsyncReadExt;
            let mut body = String::new();
            data.take((2 << 20) + 1)
                .read_to_string(&mut body)
                .block_on()
                .map_err(|e| JjError::Internal(format!("read wiki projection text: {e}")))?;
            if body.len() > 2 << 20 {
                return Err(JjError::BadRequest("wiki projection too large".into()));
            }
            Ok(Some(body))
        }
        Some(None) => Ok(None),
        _ => Err(JjError::Conflict(
            "wiki projection path is conflicted".into(),
        )),
    }
}

pub(crate) fn project(path: &Path, input: Revision) -> Result<WikiCommitResult, JjError> {
    if input.id == 0
        || input.page_id == 0
        || input.revision == 0
        || input.body.len() > 1 << 20
        || input.slug.len() > 200
        || input.title.len() > 500
        || input.author.len() > 500
    {
        return Err(JjError::BadRequest("invalid wiki revision".into()));
    }
    let page_name = validate_wiki_page_name(&format!("{}--{}", input.slug, input.page_id))?;
    let file_path = RepoPathBuf::from_internal_string(&page_name).unwrap();
    let marker =
        RepoPathBuf::from_internal_string(format!(".smithers/wiki-pages/{}.json", input.page_id))
            .unwrap();
    RepoHandle::ensure_wiki_repo(path)?;
    let settings = create_settings(&UserConfig {
        name: normalize_author_name(&input.author).into(),
        email: "wiki@smithers.sh".into(),
    });
    let (_, repo) = load_repo_at_head(path, &settings).map_err(map_load_error)?;
    let head = working_copy_commit_id(&repo)?;
    let parent = repo
        .store()
        .get_commit(&head)
        .map_err(|e| JjError::Internal(e.to_string()))?;
    let previous = read(&repo, &parent, &marker)?
        .map(|json| {
            serde_json::from_str::<Revision>(&json)
                .map_err(|_| JjError::Conflict("invalid wiki projection marker".into()))
        })
        .transpose()?;
    if let Some(old) = &previous {
        if old.revision >= input.revision {
            // Recovery after JJ committed but the API died before recording the
            // commit ID. Search native history for this page's exact revision.
            let mut next = Some(parent.clone());
            while let Some(commit) = next {
                if commit.description().trim()
                    == format!(
                        "📝 docs(wiki): page {} revision {} [receipt {}]",
                        input.page_id, input.revision, input.id
                    )
                {
                    let stored = read(&repo, &commit, &marker)?
                        .ok_or_else(|| JjError::Conflict("wiki receipt missing".into()))?;
                    let mut expected = input.clone();
                    expected.body.clear();
                    let metadata: Revision = serde_json::from_str(&stored)
                        .map_err(|_| JjError::Conflict("invalid wiki receipt".into()))?;
                    let body = read(&repo, &commit, &file_path)?;
                    if metadata != expected
                        || (!input.deleted && body.as_deref() != Some(input.body.as_str()))
                        || (input.deleted && body.is_some())
                    {
                        return Err(JjError::Conflict(
                            "wiki revision receipt belongs to different content".into(),
                        ));
                    }
                    return Ok(WikiCommitResult {
                        commit_sha: commit.id().hex(),
                    });
                }
                next = commit
                    .parent_ids()
                    .first()
                    .map(|id| {
                        repo.store()
                            .get_commit(id)
                            .map_err(|e| JjError::Internal(e.to_string()))
                    })
                    .transpose()?;
            }
            return Err(JjError::Conflict(
                "wiki revision receipt missing from history".into(),
            ));
        }
        if old.revision + 1 != input.revision {
            return Err(JjError::Conflict(
                "previous wiki revision must be projected first".into(),
            ));
        }
    } else if input.revision != 1 {
        return Err(JjError::Conflict(
            "wiki history must start at revision one".into(),
        ));
    }
    let tree_id = parent
        .tree()
        .tree_ids()
        .clone()
        .into_resolved()
        .map_err(|_| JjError::Conflict("wiki tree has conflicts".into()))?
        .clone();
    let store = repo.store();
    let mut builder = TreeBuilder::new(store.clone(), tree_id);
    if let Some(old) = previous {
        let old_name = validate_wiki_page_name(&format!("{}--{}", old.slug, old.page_id))?;
        if old_name != page_name {
            builder.remove(RepoPathBuf::from_internal_string(&old_name).unwrap());
        }
    }
    if input.deleted {
        builder.remove(file_path.clone());
    } else {
        write_blob(
            store,
            &mut builder,
            file_path.clone(),
            input.body.as_bytes(),
        )?;
    }
    let mut metadata = input.clone();
    metadata.body.clear();
    let json = serde_json::to_vec(&metadata).map_err(|e| JjError::Internal(e.to_string()))?;
    write_blob(store, &mut builder, marker, &json)?;
    let tree = builder
        .write_tree()
        .block_on()
        .map_err(|e| JjError::Internal(e.to_string()))?;
    let mut tx = repo.start_transaction();
    let commit = tx
        .repo_mut()
        .new_commit(vec![head], MergedTree::resolved(store.clone(), tree))
        .set_description(format!(
            "📝 docs(wiki): page {} revision {} [receipt {}]",
            input.page_id, input.revision, input.id
        ))
        .write()
        .block_on()
        .map_err(|e| JjError::Internal(e.to_string()))?;
    tx.repo_mut()
        .set_wc_commit(WorkspaceName::DEFAULT.to_owned(), commit.id().clone())
        .map_err(|e| JjError::Internal(e.to_string()))?;
    tx.commit(format!("project wiki revision {}", input.id))
        .block_on()
        .map_err(|e| JjError::Internal(e.to_string()))?;
    Ok(WikiCommitResult {
        commit_sha: commit.id().hex(),
    })
}

fn write_blob(
    store: &Arc<jj_lib::store::Store>,
    builder: &mut TreeBuilder,
    path: RepoPathBuf,
    mut bytes: &[u8],
) -> Result<(), JjError> {
    let id = store
        .write_file(&path, &mut bytes)
        .block_on()
        .map_err(|e| JjError::Internal(e.to_string()))?;
    builder.set(
        path,
        TreeValue::File {
            id,
            executable: false,
            copy_id: CopyId::placeholder(),
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn projection_retries_preserve_exact_history_and_rename_delete() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("repo.wiki");
        let dir = path.as_path();
        let page = Revision {
            id: 1,
            page_id: 42,
            revision: 1,
            slug: "home".into(),
            title: "Home".into(),
            body: "hello 🌎".into(),
            author: "Alice".into(),
            deleted: false,
        };
        let first = project(dir, page.clone()).unwrap().commit_sha;
        assert_eq!(first, project(dir, page.clone()).unwrap().commit_sha);
        let mut second = page.clone();
        second.id = 2;
        second.revision = 2;
        second.slug = "start".into();
        second.body = "updated".into();
        let second_id = project(dir, second.clone()).unwrap().commit_sha;
        assert_ne!(first, second_id);
        assert_eq!(first, project(dir, page.clone()).unwrap().commit_sha);
        assert!(RepoHandle::get_wiki_page_content(dir, "home--42", None).is_err());
        assert_eq!(
            "updated",
            RepoHandle::get_wiki_page_content(dir, "start--42", None)
                .unwrap()
                .content
        );
        let mut deletion = second.clone();
        deletion.id = 3;
        deletion.revision = 3;
        deletion.deleted = true;
        let deleted = project(dir, deletion.clone()).unwrap().commit_sha;
        assert_eq!(deleted, project(dir, deletion).unwrap().commit_sha);
        assert!(RepoHandle::get_wiki_page_content(dir, "start--42", None).is_err());
        second.body = "wrong retry".into();
        assert!(project(dir, second).is_err());
        let mut gap = page;
        gap.revision = 5;
        gap.id = 5;
        assert!(project(dir, gap).is_err());
    }
}
