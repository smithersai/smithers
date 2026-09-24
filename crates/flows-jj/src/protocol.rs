//! JSON request/response types for the `flows_jj_call` ABI.
//!
//! One op per call. The request/response shapes are FROZEN — they are the
//! contract between this crate and the TypeScript bridge in
//! `packages/jj/src/browser/`. `root` is an absolute path inside the WASI
//! namespace: the jj workspace root.

use serde::Deserialize;
use serde::Serialize;

use crate::error::ErrorCode;

/// A single `Jj` op request.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Init {
        root: String,
    },
    Snapshot {
        root: String,
        #[serde(default)]
        message: Option<String>,
    },
    Restore {
        root: String,
        change_id: String,
    },
    Diff {
        root: String,
        from: String,
        to: String,
    },
    WorkspaceAdd {
        root: String,
        name: String,
        path: String,
    },
    WorkspaceForget {
        root: String,
        name: String,
    },
    Status {
        root: String,
    },
}

impl Request {
    /// The human-oriented equivalent CLI command, reported in the `command`
    /// field of error responses. Error *messages* stay bare — the TypeScript
    /// bridge prefixes them with `jj {method}: `, exactly like `NodeJj` does
    /// with stderr, so a crate-side prefix would double up.
    pub fn command(&self) -> String {
        match self {
            Self::Init { .. } => "jj init".into(),
            Self::Snapshot { message: None, .. } => "jj describe --quiet && jj new --quiet".into(),
            Self::Snapshot {
                message: Some(message),
                ..
            } => format!("jj describe -m {message:?} --quiet && jj new --quiet"),
            Self::Restore { change_id, .. } => format!("jj restore --from {change_id}"),
            Self::Diff { from, to, .. } => format!("jj diff --from {from} --to {to} --git"),
            Self::WorkspaceAdd { name, path, .. } => {
                format!("jj workspace add --name {name} {path}")
            }
            Self::WorkspaceForget { name, .. } => format!("jj workspace forget {name}"),
            Self::Status { .. } => "jj status".into(),
        }
    }
}

/// The `ok` payload of a response. Serialized untagged: `snapshot` returns
/// `{"commitId":"...","changeId":"..."}` (restore by `commitId`; `changeId`
/// is display only), `diff` returns `{"diff":"..."}`, `status` returns
/// `{"status":"..."}`, everything else returns `{}`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OkPayload {
    Snapshot {
        #[serde(rename = "commitId")]
        commit_id: String,
        #[serde(rename = "changeId")]
        change_id: String,
    },
    Diff {
        diff: String,
    },
    Status {
        status: String,
    },
    Unit {},
}

/// The `err` payload of a response.
#[derive(Clone, Debug, Serialize)]
pub struct ErrPayload {
    pub code: ErrorCode,
    pub message: String,
    pub command: String,
}

/// A complete response: exactly one of `{"ok":...}` or `{"err":...}`.
#[derive(Clone, Debug, Serialize)]
pub enum Response {
    #[serde(rename = "ok")]
    Ok(OkPayload),
    #[serde(rename = "err")]
    Err(ErrPayload),
}
