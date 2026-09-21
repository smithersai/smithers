use super::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct AppendPreparationRequest {
    pub target_bookmark: String,
    pub expected_commit_id: String,
    pub source_commit_id: String,
    pub source_base_commit_id: String,
}
#[derive(Serialize)]
pub(crate) struct AppendPreparation {
    status: &'static str,
    #[serde(flatten)]
    request: AppendPreparationRequest,
    changes: Vec<Change>,
}
impl RepoHandle {
    pub(crate) fn prepare_append(
        &self,
        request: AppendPreparationRequest,
    ) -> Result<AppendPreparation, JjError> {
        let immutable = |id: &str| {
            id.len() == 40
                && id
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        };
        if request.target_bookmark.is_empty()
            || request.target_bookmark.trim() != request.target_bookmark
            || !immutable(&request.expected_commit_id)
            || !immutable(&request.source_commit_id)
            || !immutable(&request.source_base_commit_id)
        {
            return Err(JjError::BadRequest(
                "append preparation requires exact immutable commits and a target bookmark".into(),
            ));
        }
        let target = self
            .repo
            .view()
            .get_local_bookmark(RefName::new(&request.target_bookmark));
        let current = target
            .as_normal()
            .ok_or_else(|| JjError::Conflict("append target must exist without conflict".into()))?;
        if current.hex() != request.expected_commit_id {
            return Err(JjError::Conflict(
                "target bookmark changed since preparation".into(),
            ));
        }
        let mut anchor: Option<String> = None;
        let mut operations = Box::pin(op_walk::walk_ancestors(std::slice::from_ref(
            self.repo.operation(),
        )));
        let mut inspected = 0;
        while let Some(operation) = operations.next().block_on() {
            inspected += 1;
            if inspected > 100_000 {
                return Err(JjError::BadRequest(
                    "append operation history exceeds 100000 entries".into(),
                ));
            }
            let operation = operation.map_err(|e| JjError::Internal(e.to_string()))?;
            let attrs = &operation.metadata().attributes;
            if let (Some(saved_request), Some(saved_result)) = (
                attrs.get("smithers.land.request"),
                attrs.get("smithers.land.result"),
            ) {
                if let (Ok(saved_request), Ok(saved_result)) = (
                    serde_json::from_str::<LandRequest>(saved_request),
                    serde_json::from_str::<LandResult>(saved_result),
                ) {
                    if let Some(saved_append) = saved_request.append {
                        if saved_result.target_commit_id == request.expected_commit_id
                            && saved_result.target_bookmark == request.target_bookmark
                            && saved_request.target_bookmark == request.target_bookmark
                            && attrs.get("smithers.land.key") == Some(&saved_request.operation_key)
                        {
                            if anchor
                                .as_ref()
                                .is_some_and(|id| id != &saved_append.source_commit_id)
                            {
                                return Err(JjError::Conflict(
                                    "target has ambiguous native append receipts".into(),
                                ));
                            }
                            anchor = Some(saved_append.source_commit_id);
                        }
                    }
                }
            }
        }
        let append = LandAppend {
            source_commit_id: request.source_commit_id.clone(),
            source_base_commit_id: request.source_base_commit_id.clone(),
            description: String::new(),
        };
        let ids = self.append_required_suffix(current, &append, &anchor)?;
        if ids.is_empty() {
            return Err(JjError::Conflict(
                "append source has no current suffix to land".into(),
            ));
        }
        let mut changes = Vec::with_capacity(ids.len());
        let mut seen = HashSet::new();
        for id in ids {
            let commit = self
                .repo
                .store()
                .get_commit(&id)
                .map_err(|e| JjError::Internal(e.to_string()))?;
            if commit.tree().has_conflict() {
                return Err(JjError::Conflict(
                    "append source contains a conflicted revision".into(),
                ));
            }
            let change = change_from_commit(&self.repo, &commit);
            if !seen.insert(change.change_id.clone()) {
                return Err(JjError::Conflict(
                    "append source repeats a native change ID".into(),
                ));
            }
            changes.push(change);
        }
        Ok(AppendPreparation {
            status: "prepared",
            request,
            changes,
        })
    }
}

/// Read the exact native append suffix without starting or committing a transaction.
#[no_mangle]
pub extern "C" fn smithers_prepare_land_append(
    path: *const c_char,
    request: *const c_char,
) -> *mut c_char {
    execute(|| {
        let handle = open_repo(path)?;
        let request = parse_c_string(request, "request")?;
        let request: AppendPreparationRequest = serde_json::from_str(&request)
            .map_err(|e| FfiError::from(JjError::BadRequest(e.to_string())))?;
        handle.prepare_append(request).map_err(FfiError::from)
    })
}
