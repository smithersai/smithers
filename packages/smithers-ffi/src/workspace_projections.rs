//! Reconstruct API head projections from the native JJ operation log.
use std::collections::HashMap;
use std::path::Path;

use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde_json::{json, Value};

use super::workspace_engine::{field, jj, Failure};
use super::workspace_local::{change_in_operation, jj_at, operation_args};

type Result<T> = std::result::Result<T, Failure>;

fn projection(operation: &Value, workspace: &str, repo: &Path) -> Option<Value> {
    // JJ's operation args use JJ quoting, not shell quoting. Accept only the
    // generated prefix and one exact config argument; arbitrary message text
    // and an unrelated user config cannot become a coding receipt.
    let path = repo.to_str()?;
    let quoted = if path
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b",./:@_-".contains(&c))
    {
        path.to_owned()
    } else {
        format!("'{}'", path.replace('\'', "\\'"))
    };
    let prefix = format!("jj -R {quoted} --no-pager '--color=never' ");
    let mut args = operation_args(operation).strip_prefix(&prefix)?;
    let mut marker = None;
    while let Some(after) = args.strip_prefix("--config 'smithers.") {
        let (kind, after) = after.split_once("=\"")?;
        if !["coding-request", "coding-projection"].contains(&kind) {
            return None;
        }
        let (encoded, remaining) = after.split_once("\"' ")?;
        if encoded.contains('"') {
            return None;
        }
        if kind == "coding-projection" && marker.replace(encoded).is_some() {
            return None;
        }
        args = remaining;
    }
    let raw = BASE64_STANDARD.decode(marker?).ok()?;
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
    // Resolve the target exactly as the mutation did: a divergent change is
    // the one version on the working branch at the projected operation.
    let target = if ["create", "snapshot", "apply_files"].contains(&kind) {
        let mut head = rows(repo, current, "@")?;
        if head.len() != 1 {
            return Err(Failure::new(
                "revision_conflict",
                "projection target is unavailable",
            ));
        }
        head.remove(0)
    } else {
        change_in_operation(repo, target_change, current)?
    };
    let target_id = field(&target, "commit_id")?;
    let target_change = field(&target, "change_id")?;
    let mut selectors: Vec<_> = previous
        .keys()
        .filter(|id| valid_change(id))
        .map(|id| format!("change_id(\"{id}\")"))
        .collect();
    selectors.push(target_id.to_owned());
    let updated = rows(repo, current, &selectors.join(" | "))?;
    let mut changed: Vec<String> = Vec::new();
    for value in &updated {
        let (Some(change), Some(commit)) = (
            value.get("change_id").and_then(Value::as_str),
            value.get("commit_id").and_then(Value::as_str),
        ) else {
            continue;
        };
        // Every version of a divergent change matches its selector; report
        // the logical change once.
        if (previous.get(change).is_none_or(|old| old != commit) || change == target_change)
            && !changed.iter().any(|seen| seen == change)
        {
            changed.push(change.to_owned());
        }
    }
    Ok(changed)
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
        let previous = std::mem::replace(&mut cursor, field(operation, "id")?.to_owned());
        let Some(request) = projection(operation, workspace, repo) else {
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
        // An accepted receipt that cannot be projected stops the page before
        // it, so a retry delivers it instead of skipping the accepted edit.
        let changed = match affected(repo, operation, &request) {
            Ok(value) => value,
            Err(error) if records.is_empty() => return Err(error),
            Err(_) => {
                cursor = previous;
                scanned -= 1;
                break;
            }
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
    fn ignores_forged_projection_text_and_duplicate_config_markers() {
        let repo = Path::new("/tmp/projection-repo");
        let workspace = "22222222-2222-4222-8222-222222222222";
        let encoded = BASE64_STANDARD.encode(
            serde_json::to_vec(&json!({
                "version":1, "workspaceId":workspace, "request":{"operation":"create"}
            }))
            .unwrap(),
        );
        let marker = format!("--config 'smithers.coding-projection=\"{encoded}\"' ");
        let prefix = "jj -R /tmp/projection-repo --no-pager '--color=never' ";
        // jj 0.39 records the invocation under `tags`; later releases under
        // `attributes`. Both must project, and both must refuse forgeries.
        for key in ["tags", "attributes"] {
            let legitimate = json!({key:{"args":format!("{prefix}{marker}new")}});
            assert!(projection(&legitimate, workspace, repo).is_some(), "{key}");
            let message = json!({key:{"args":format!("{prefix}describe -m \"{marker}\"")}});
            assert!(projection(&message, workspace, repo).is_none(), "{key}");
            let duplicate = json!({key:{"args":format!("{prefix}{marker}{marker}new")}});
            assert!(projection(&duplicate, workspace, repo).is_none(), "{key}");
        }
    }

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

    // Runs the helper as the local owner; returns its result and workspace ID.
    fn helper(dir: &Path, request: Value) -> (Value, String) {
        unsafe {
            std::env::set_var("SMITHERS_CODING_LOCAL_OWNER", "1");
        }
        let result =
            super::super::workspace_local::run(serde_json::to_string(&request).unwrap().as_bytes());
        let owner = super::super::workspace_local::local_owner(dir);
        unsafe {
            std::env::remove_var("SMITHERS_CODING_LOCAL_OWNER");
        }
        (result.unwrap(), owner.unwrap().workspace_id)
    }

    fn invoke(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("jj")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn projects_an_accepted_edit_of_a_divergent_change_once() {
        let _guard = super::super::workspace_local::LOCAL_OWNER_TEST_LOCK
            .lock()
            .unwrap();
        let dir = tempdir().unwrap();
        invoke(dir.path(), &["git", "init"]);
        invoke(dir.path(), &["describe", "-m", "base"]);
        let operation = invoke(
            dir.path(),
            &["op", "log", "--limit", "1", "--no-graph", "-T", "id"],
        );
        let change = invoke(
            dir.path(),
            &["log", "-r", "@", "--no-graph", "-T", "change_id"],
        );
        invoke(
            dir.path(),
            &["--at-op", &operation, "describe", "-m", "left"],
        );
        invoke(
            dir.path(),
            &["--at-op", &operation, "describe", "-m", "right"],
        );
        // Reconcile the concurrent operations; the other version stays visible.
        invoke(
            dir.path(),
            &["log", "-r", "@", "--no-graph", "-T", "commit_id"],
        );
        let (read, _) = helper(
            dir.path(),
            json!({"operation":"read", "repositoryPath":dir.path(), "changeIds":[change]}),
        );
        let (described, workspace) = helper(
            dir.path(),
            json!({"operation":"describe", "repositoryPath":dir.path(),
                "requestId":"12345678-1234-4234-8234-123456789abc",
                "expectedOperationId":read["operationId"], "target":read["head"], "description":"final"}),
        );
        assert_eq!(described["revision"]["changeId"], change);
        let both = invoke(
            dir.path(),
            &[
                "log",
                "-r",
                &format!("change_id(\"{change}\")"),
                "--no-graph",
                "-T",
                "commit_id ++ \"\\n\"",
            ],
        );
        assert_eq!(both.lines().count(), 2, "the change stays divergent");
        let projections = run(dir.path(), &workspace, "").unwrap();
        let records = projections["coding_operations"].as_array().unwrap();
        assert_eq!(records.len(), 1, "{projections}");
        assert_eq!(records[0]["operationId"], described["operationId"]);
        assert_eq!(records[0]["changeIds"], json!([change]));
        assert_eq!(projections["cursor"], described["operationId"]);
    }

    #[test]
    fn an_unprojectable_receipt_ends_the_page_without_consuming_its_cursor() {
        let _guard = super::super::workspace_local::LOCAL_OWNER_TEST_LOCK
            .lock()
            .unwrap();
        let dir = tempdir().unwrap();
        invoke(dir.path(), &["git", "init"]);
        let (base, _) = helper(
            dir.path(),
            json!({"operation":"read", "repositoryPath":dir.path()}),
        );
        let (described, workspace) = helper(
            dir.path(),
            json!({"operation":"describe", "repositoryPath":dir.path(),
                "requestId":"23456789-2345-4345-8345-23456789abcd",
                "expectedOperationId":base["operationId"], "target":base["head"], "description":"first"}),
        );
        // A receipt in the helper's exact form whose target commit cannot be
        // resolved: projecting it fails on every attempt.
        let encoded = BASE64_STANDARD.encode(
            json!({"version":1, "workspaceId":workspace, "request":{"operation":"describe",
                "expectedOperationId":described["operationId"],
                "target":{"changeId":described["revision"]["changeId"], "commitId":"not-a-commit"}}})
            .to_string(),
        );
        let marker = format!("smithers.coding-projection=\"{encoded}\"");
        let status = Command::new("jj")
            .arg("-R")
            .arg(dir.path())
            .args([
                "--no-pager",
                "--color=never",
                "--config",
                &marker,
                "describe",
                "-m",
                "second",
            ])
            .current_dir(dir.path())
            .status()
            .unwrap();
        assert!(status.success());
        let page = run(dir.path(), &workspace, "").unwrap();
        assert_eq!(
            page["coding_operations"].as_array().unwrap().len(),
            1,
            "{page}"
        );
        assert_eq!(page["cursor"], described["operationId"]);
        assert_eq!(page["more"], true);
        let retry = run(dir.path(), &workspace, page["cursor"].as_str().unwrap()).unwrap_err();
        assert_eq!(retry.code, "invalid_request");
    }
}
