//! Immutable engine snapshots through the same packaged helper on every host.
use std::os::fd::AsRawFd;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use super::file_eligibility;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Serialize)]
pub struct Failure {
    pub(super) code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery: Option<Value>,
}

impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            recovery: None,
        }
    }

    pub fn with_recovery(mut self, recovery: Value) -> Self {
        self.recovery = Some(recovery);
        self
    }
}

type Result<T> = std::result::Result<T, Failure>;

pub(super) fn invalid(message: &str) -> Failure {
    Failure::new("invalid_request", message)
}

pub(super) fn jj(repo: &Path, args: &[&str], mutable: bool) -> Result<String> {
    let mut command = Command::new("jj");
    command
        .arg("-R")
        .arg(repo)
        .args(["--no-pager", "--color=never"]);
    if !mutable {
        command.args(["--ignore-working-copy", "--at-op=@"]);
    }
    let output = command
        .args(args)
        .current_dir(repo)
        .env("JJ_EDITOR", "false")
        .env("PAGER", "cat")
        .output()
        .map_err(|error| Failure::new("unsupported_jj", format!("JJ is unavailable: {error}")))?;
    if !output.status.success() {
        return Err(Failure::new(
            "jj_conflict",
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(2000)
                .collect::<String>(),
        ));
    }
    String::from_utf8(output.stdout)
        .map_err(|_| Failure::new("unsupported_jj", "JJ returned non-UTF8 output"))
}

pub(super) fn commit(repo: &Path, selector: &str) -> Result<Value> {
    let output = jj(
        repo,
        &["log", "-r", selector, "--no-graph", "-T", "json(self)"],
        false,
    )?;
    serde_json::from_str(&output).map_err(|_| {
        Failure::new(
            "revision_conflict",
            "revision does not resolve to one native commit",
        )
    })
}

pub(super) fn field<'a>(input: &'a Value, name: &str) -> Result<&'a str> {
    input
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("missing or invalid engine request field"))
}

fn exact_commit(value: &str) -> Result<&str> {
    if value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(value)
    } else {
        Err(Failure::new(
            "invalid_ref",
            "engine snapshots require full lowercase immutable commit IDs",
        ))
    }
}

pub(super) fn id(value: &Value) -> Result<&str> {
    value
        .get("commit_id")
        .and_then(Value::as_str)
        .ok_or_else(|| Failure::new("unsupported_jj", "JJ commit template has no ID"))
}

fn owner(value: &Value) -> Result<(&str, &Value)> {
    Ok((
        value
            .get("change_id")
            .and_then(Value::as_str)
            .ok_or_else(|| Failure::new("unsupported_jj", "JJ commit template has no change ID"))?,
        value
            .get("parents")
            .ok_or_else(|| Failure::new("unsupported_jj", "JJ commit template has no parents"))?,
    ))
}

fn checked_input(raw: &[u8]) -> Result<Value> {
    let input: Value =
        serde_json::from_slice(raw).map_err(|_| invalid("engine request is not JSON"))?;
    let object = input
        .as_object()
        .ok_or_else(|| invalid("engine request must be an object"))?;
    let operation = field(&input, "operation")?;
    let expected: &[&str] = match operation {
        "snapshot" => &["operation", "repositoryPath"],
        "restore" => &["operation", "repositoryPath", "changeId"],
        "diff" => &["operation", "repositoryPath", "from", "to"],
        "eligible" => &["operation", "repositoryPath", "path", "byteLength"],
        _ => return Err(invalid("unsupported engine operation")),
    };
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(invalid("engine operation fields do not match its command"));
    }
    let repo = field(&input, "repositoryPath")?;
    if !Path::new(repo).is_absolute() {
        return Err(invalid("repository path must be absolute"));
    }
    for name in ["changeId", "from", "to"] {
        if let Some(value) = input.get(name) {
            exact_commit(value.as_str().ok_or_else(|| invalid("invalid commit ID"))?)?;
        }
    }
    Ok(input)
}

pub(super) struct CodingLock(std::fs::File);

impl CodingLock {
    pub(super) fn acquire(repo: &Path) -> Result<Self> {
        let jj_dir = repo.join(".jj");
        let mut repo_dir = jj_dir.join("repo");
        if repo_dir.is_file() {
            let pointer = std::fs::read_to_string(&repo_dir)
                .map_err(|_| Failure::new("workspace_busy", "cannot locate JJ operation store"))?;
            repo_dir = jj_dir
                .join(pointer.trim())
                .canonicalize()
                .map_err(|_| Failure::new("workspace_busy", "cannot locate JJ operation store"))?;
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(repo_dir.join("smithers-coding.lock"))
            .map_err(|_| Failure::new("workspace_busy", "cannot open native coding lock"))?;
        let until = Instant::now() + Duration::from_secs(15);
        loop {
            // SAFETY: flock receives this live file descriptor; the guard
            // keeps it open until the operation finishes.
            let outcome = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if outcome == 0 {
                return Ok(Self(file));
            }
            if Instant::now() >= until {
                return Err(Failure::new(
                    "workspace_busy",
                    "another native coding operation is running",
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for CodingLock {
    fn drop(&mut self) {
        // SAFETY: the file descriptor remains open during Drop.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

pub fn run(raw: &[u8]) -> Result<Value> {
    let input = checked_input(raw)?;
    let repo = Path::new(field(&input, "repositoryPath")?);
    let _lock = CodingLock::acquire(repo)?;
    match field(&input, "operation")? {
        "diff" => {
            let from = field(&input, "from")?;
            let to = field(&input, "to")?;
            commit(repo, from)?;
            commit(repo, to)?;
            Ok(json!({"diff":jj(repo, &["diff", "--git", "--from", from, "--to", to], false)?}))
        }
        "eligible" => {
            let path = field(&input, "path")?;
            let byte_length = input
                .get("byteLength")
                .and_then(Value::as_u64)
                .filter(|value| *value <= (1u64 << 53) - 1)
                .ok_or_else(|| invalid("eligibility requires a nonnegative exact byte length"))?;
            let current = commit(repo, "@")?;
            let config =
                |key| jj(repo, &["config", "get", key], false).map(|value| value.trim().to_owned());
            let aliases = jj(
                repo,
                &["config", "list", "fileset-aliases", "--include-defaults"],
                false,
            )?;
            let request = json!({"commitId":id(&current)?, "path":path, "byteLength":byte_length,
                "autoTrack":config("snapshot.auto-track")?, "maxNewFileSize":config("snapshot.max-new-file-size")?, "filesetAliases":aliases});
            file_eligibility::check(
                repo,
                serde_json::from_value(request)
                    .map_err(|_| invalid("invalid eligibility request"))?,
            )
            .and_then(|answer| {
                serde_json::to_value(answer)
                    .map_err(|_| anyhow::anyhow!("invalid eligibility answer"))
            })
            .map_err(|_| {
                Failure::new(
                    "eligibility_unavailable",
                    "native eligibility could not be verified",
                )
            })
        }
        "snapshot" | "restore" => {
            let restoring = field(&input, "operation")? == "restore";
            let source = if restoring {
                Some(commit(repo, field(&input, "changeId")?)?)
            } else {
                None
            };
            let before = commit(repo, "@")?;
            if let Some(source) = &source {
                if owner(&before)? != owner(source)? {
                    return Err(Failure::new(
                        "revision_conflict",
                        "snapshot belongs to another change or parent revision",
                    ));
                }
            }
            let status = jj(repo, &["status"], true)?;
            if status.lines().any(|line| line == "Untracked paths:") {
                return Err(Failure::new(
                    "snapshot_incomplete",
                    "JJ left untracked paths",
                ));
            }
            let current = commit(repo, "@")?;
            if owner(&before)? != owner(&current)? {
                return Err(Failure::new(
                    "revision_conflict",
                    "working-copy owner changed during snapshot",
                ));
            }
            if let Some(source) = source {
                let from = format!("commit_id(\"{}\")", id(&source)?);
                let into = format!("commit_id(\"{}\")", id(&current)?);
                jj(repo, &["restore", "--from", &from, "--into", &into], true)?;
                let restored = commit(repo, "@")?;
                if owner(&restored)? != owner(&source)?
                    || restored.get("description") != current.get("description")
                {
                    return Err(Failure::new(
                        "revision_conflict",
                        "restored revision changed its owner or description",
                    ));
                }
                if !jj(
                    repo,
                    &[
                        "diff",
                        "--summary",
                        "--from",
                        id(&source)?,
                        "--to",
                        id(&restored)?,
                    ],
                    false,
                )?
                .is_empty()
                {
                    return Err(Failure::new(
                        "revision_conflict",
                        "restored tree differs from the immutable snapshot",
                    ));
                }
                Ok(json!({"changeId":id(&restored)?}))
            } else {
                Ok(json!({"changeId":id(&current)?}))
            }
        }
        _ => Err(invalid("unsupported engine operation")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn repo() -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        let output = Command::new("jj")
            .args(["git", "init", dir.path().to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        dir
    }

    fn call(path: &Path, operation: &str, fields: Value) -> Result<Value> {
        let mut request = json!({"operation":operation, "repositoryPath":path});
        request
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        run(serde_json::to_string(&request).unwrap().as_bytes())
    }

    #[test]
    fn snapshot_diff_and_restore_owned_file_bytes() {
        let dir = repo();
        fs::write(dir.path().join("file.txt"), "before\n").unwrap();
        let first = call(dir.path(), "snapshot", json!({})).unwrap();
        fs::write(dir.path().join("file.txt"), "after\n").unwrap();
        let second = call(dir.path(), "snapshot", json!({})).unwrap();
        let diff = call(
            dir.path(),
            "diff",
            json!({"from":first["changeId"], "to":second["changeId"]}),
        )
        .unwrap();
        assert!(diff["diff"].as_str().unwrap().contains("+after"));
        call(dir.path(), "restore", json!({"changeId":first["changeId"]})).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("file.txt")).unwrap(),
            "before\n"
        );
    }

    #[test]
    fn rejects_mutable_refs_and_extra_fields() {
        let dir = repo();
        assert_eq!(
            call(dir.path(), "restore", json!({"changeId":"@"}))
                .unwrap_err()
                .code,
            "invalid_ref"
        );
        assert_eq!(
            call(dir.path(), "snapshot", json!({"target":"@"}))
                .unwrap_err()
                .code,
            "invalid_request"
        );
    }

    #[test]
    fn eligibility_refuses_metadata() {
        let dir = repo();
        let answer = call(
            dir.path(),
            "eligible",
            json!({"path":".git/config", "byteLength":1}),
        )
        .unwrap();
        assert_eq!(answer["eligible"], false);
    }
}
