//! Reconstruct API head projections from the native JJ operation log.
use std::collections::HashMap;
use std::path::Path;

use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde_json::{json, Value};

use super::workspace_engine::{field, jj, Failure};
use super::workspace_local::jj_at;

type Result<T> = std::result::Result<T, Failure>;

fn op_args(operation: &Value) -> &str {
    operation
        .pointer("/tags/args")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn projection(operation: &Value, workspace: &str) -> Option<Value> {
    let args = op_args(operation);
    let marker = "smithers.coding-projection=\"";
    let start = args.find(marker)? + marker.len();
    let end = args[start..].find('"')? + start;
    let raw = BASE64_STANDARD.decode(&args[start..end]).ok()?;
    let value: Value = serde_json::from_slice(&raw).ok()?;
    (value["version"] == 1 && value["workspaceId"] == workspace).then_some(value["request"].clone())
}

fn rows(repo: &Path, op: &str, selector: &str) -> Result<Vec<Value>> {
    let output = jj_at(
        repo,
        op,
        &[
            "log",
            "-r",
            selector,
            "--no-graph",
            "-T",
            "json(self) ++ \"\\n\"",
        ],
    )?;
    output
        .lines()
        .map(|line| {
            serde_json::from_str(line)
                .map_err(|_| Failure::new("unsupported_jj", "native revision history is invalid"))
        })
        .collect()
}

fn valid_change(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| (b'k'..=b'z').contains(&byte))
}
fn valid_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn affected(repo: &Path, operation: &Value, request: &Value) -> Result<Vec<String>> {
    let current = field(operation, "id")?;
    let before = operation["parents"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::new("operation_conflict", "projection operation has no parent"))?;
    let mut roots = Vec::new();
    for name in ["target", "source", "after"] {
        if let Some(value) = request.get(name) {
            let commit = field(value, "commitId")?;
            if !valid_commit(commit) {
                return Err(Failure::new(
                    "invalid_request",
                    "projection commit is invalid",
                ));
            }
            roots.push(format!("{commit}::"));
        }
    }
    let old = rows(repo, before, &roots.join(" | "))?;
    let previous: HashMap<_, _> = old
        .iter()
        .filter_map(|value| {
            Some((
                value.get("change_id")?.as_str()?.to_owned(),
                value.get("commit_id")?.as_str()?.to_owned(),
            ))
        })
        .collect();
    let target_change = field(&request["target"], "changeId")?;
    if !valid_change(target_change) {
        return Err(Failure::new(
            "invalid_request",
            "projection change is invalid",
        ));
    }
    let kind = field(request, "operation")?;
    let target_selector = if ["create", "snapshot", "apply_files"].contains(&kind) {
        "@".to_owned()
    } else {
        format!("change_id(\"{target_change}\")")
    };
    let target = rows(repo, current, &target_selector)?;
    if target.len() != 1 {
        return Err(Failure::new(
            "revision_conflict",
            "projection target is unavailable",
        ));
    }
    let target_id = field(&target[0], "commit_id")?;
    let mut selectors: Vec<_> = previous
        .keys()
        .filter(|id| valid_change(id))
        .map(|id| format!("change_id(\"{id}\")"))
        .collect();
    selectors.push(target_id.to_owned());
    let updated = rows(repo, current, &selectors.join(" | "))?;
    Ok(updated
        .into_iter()
        .filter_map(|value| {
            let change = value.get("change_id")?.as_str()?;
            let commit = value.get("commit_id")?.as_str()?;
            (previous.get(change).is_none_or(|old| old != commit)
                || change == field(&target[0], "change_id").ok()?)
            .then(|| change.to_owned())
        })
        .collect())
}

pub fn run(repo: &Path, workspace: &str, after: &str) -> Result<Value> {
    let output = jj(
        repo,
        &["op", "log", "--no-graph", "-T", "json(self) ++ \"\\n\""],
        false,
    )?;
    let mut operations: Vec<Value> = output
        .lines()
        .map(|line| {
            serde_json::from_str(line)
                .map_err(|_| Failure::new("unsupported_jj", "native operation log is invalid"))
        })
        .collect::<Result<_>>()?;
    operations.reverse();
    let offset = operations
        .iter()
        .position(|operation| operation["id"] == after)
        .map(|index| index + 1)
        .unwrap_or(0);
    let mut records = Vec::new();
    let mut cursor = after.to_owned();
    let mut scanned = 0;
    for operation in operations.iter().skip(offset) {
        scanned += 1;
        cursor = field(operation, "id")?.to_owned();
        let Some(request) = projection(operation, workspace) else {
            continue;
        };
        if operation["parents"].as_array().is_none_or(|parents| {
            parents.len() != 1 || parents[0] != request["expectedOperationId"]
        }) {
            continue;
        }
        let kind = match field(&request, "operation") {
            Ok(value) => value,
            Err(_) => continue,
        };
        if operation["is_snapshot"] == true && !["snapshot", "apply_files"].contains(&kind) {
            continue;
        }
        let changed = match affected(repo, operation, &request) {
            Ok(value) => value,
            Err(_) => continue,
        };
        records.push(json!({"operation":kind, "operationId":operation["id"],
            "parentOperationId":operation["parents"][0], "timestamp":operation["time"]["end"],
            "changeIds":changed}));
        if records.len() == 20 {
            break;
        }
    }
    Ok(
        json!({"coding_operations":records, "cursor":cursor, "more":offset + scanned < operations.len()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    #[test]
    fn projects_the_exact_native_receipt_after_an_accepted_edit() {
        let _guard = super::super::workspace_local::LOCAL_OWNER_TEST_LOCK
            .lock()
            .unwrap();
        let dir = tempdir().unwrap();
        let status = Command::new("jj")
            .args(["git", "init", dir.path().to_str().unwrap()])
            .status()
            .unwrap();
        assert!(status.success());
        unsafe {
            std::env::set_var("SMITHERS_CODING_LOCAL_OWNER", "1");
        }
        let base = super::super::workspace_local::run(
            serde_json::to_string(&json!({
                "operation":"read", "repositoryPath":dir.path()
            }))
            .unwrap()
            .as_bytes(),
        )
        .unwrap();
        let owner = super::super::workspace_local::local_owner(dir.path()).unwrap();
        let request = json!({"operation":"create", "repositoryPath":dir.path(),
            "requestId":"77777777-7777-4777-8777-777777777777", "expectedOperationId":base["operationId"],
            "target":base["head"], "description":"projected"});
        let result =
            super::super::workspace_local::run(serde_json::to_string(&request).unwrap().as_bytes())
                .unwrap();
        unsafe {
            std::env::remove_var("SMITHERS_CODING_LOCAL_OWNER");
        }
        let projections = run(dir.path(), &owner.workspace_id, "").unwrap();
        let records = projections["coding_operations"].as_array().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["operationId"], result["operationId"]);
        assert_eq!(
            records[0]["changeIds"],
            json!([result["revision"]["changeId"]])
        );
    }
}
