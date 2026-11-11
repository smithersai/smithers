---
title: "The project and its state"
description: "How an invocation decides which project it is running in, what lives under .flows/, and how the CLI reports Smithers 0.x state it finds beside a project."
sidebar:
  order: 2
---

Every command that touches durable state resolves the same project root the
same way. Smithers 0.x's most reported operational surprise was two commands
in one repository disagreeing about which database they meant, so rc.0 makes
the decision once, before any layer is built, and hands the answer to every
handler as the `Project.ProjectRoot` service.

## How the root is resolved

`Project.root(explicit, cwd)` applies three rules in order:

1. An explicit `--root`, resolved against the invocation directory.
2. Otherwise the nearest ancestor that anchors a project.
3. Otherwise the invocation directory itself.

A directory anchors a project when it holds `.flows/`, or when it holds
`.smithers/flows/` beside a `package.json`, `.git`, or `.jj`. The two rules
differ because Smithers writes `.flows/` on its own, while a person writes
`.smithers/flows/`: requiring a project marker next to it keeps the anchor on
the directory a project actually starts at. A root `flows/` anchors nothing.

The upward walk stops at the repository root, inclusive, on `.git` or `.jj`.
Without that bound, a command run in a repository under `$HOME` would keep
climbing into the home directory, and rc.0 reads no global state at all.

## What lives under the root

| Path | What it holds |
| --- | --- |
| `.smithers/flows/` | The flow sources this project discovers. One directory per flow. |
| `.flows/` | Everything Smithers writes. Add it to `.gitignore`; `smthrs init` does that for you in a repository. |
| `.flows/control.db` | The control plane: runs, plans, approvals, memory, and the journal. |
| `.flows/engine.db` | The durable engine: executions, attempts, cache entries, and wake state. |
| `.flows/logs/<run-id>.log` | One detached run's output. |

Embedded native hosts can set `Application.Config.stateRoot` outside the
checkout. The control and engine databases then live under
`<stateRoot>/.flows/`, with their WAL files, while discovery, grants, and run
workspace access remain rooted in the project. It defaults to `root` and has no
CLI flag. This keeps database writes from changing a live checkout's tree.

The two databases are separate files with separate connections and separate
migration ownership. `NodeControl.databasePath` and
`NodeControl.executionDatabasePath` are the database projections; other state
paths start with `Project.stateDirectory`. Workspace routing uses the same pure
projections through internal modules to avoid importing its NodeControl host.
Nothing assembles `.flows` paths at a call site.

Local control and operator commands share one database initialization layer.
On POSIX systems it creates a missing database parent with mode `0700`, leaving
an existing parent directory's permissions unchanged. The control database and
its WAL and shared-memory files are restricted to `0600` before exposing the
store, including when reopening existing files. This also applies when
`credentials add` or a memory command creates the first state in a project.

Within one local invocation there is exactly one durable engine, and its SQLite
connection is shared by the control runtime, the journal, the run store, and
the memory store. Building those layers independently would open several
writers on one file.

`smthrs doctor` prints the resolved root, both database paths, and how many
migrations each file has recorded, which is the fastest way to confirm that a
command is acting on the project you think it is.

## Discovery

`NodeControl.layerRegistry` discovers flows from one source: `.smithers/flows/`
under the project root, named by path. A project with no `.smithers/flows/`
directory simply has no flows, and `smthrs flow list` says so. Smithers never
reads a root `flows/`. If one still holds flow files, none of them load, and
discovery reports one `retired_root` warning, which `smthrs flow list` prints:
`Flows in flows/ are not loaded; move them to .smithers/flows/.` Any other discovery failure, such as an
unreadable root or a malformed entry, is a startup failure rather than a
silently empty catalog.

## Smithers 0.x state beside a project

rc.0 never loads a 0.x run database. It detects one so it can say so once
instead of failing obscurely later.

`Project.legacyMarkers` are the names it looks for: `.smithers`,
`smithers.db`, and that database's WAL and shared-memory files. Two different
questions are asked about them, and they are gated differently on purpose:

- **The notice.** `Project.legacyState` skips any directory that already holds
  `.flows/`, because a repository mid-migration would otherwise print the
  notice on every command forever. The sample is taken while the layers are
  still being described, before anything opens the control database, since
  opening it creates `.flows/` and would erase the very condition being tested.
- **The report and the refusal.** `Project.legacyDatabases` is not gated that
  way. The project an operator actually migrates has already run an rc.0
  command, so it already has `.flows/`, and gating there would answer "nothing
  to finish" for every real migration. `smthrs doctor` and `smthrs migrate`
  read this one.

The notice names the path, states that rc.0 does not load, resume, or migrate
0.x run databases, and tells you to finish or discard those runs with the 0.x
CLI before running `smthrs migrate` on the project source.

`smthrs migrate` resolves a different root again, `Project.legacyRoot`, which
anchors on the 0.x markers rather than on `.flows/`. That keeps
`migrate --apply` on the 0.x project holding those markers, even when it sits
inside a larger repository and carries no repository marker of its own.

## The environment

`Environment.names` is the closed set of `SMITHERS_*` variables rc.0 reads.
Anything outside it is not read, including the 0.x `SMITHERS_HOME`,
`SMITHERS_TOKEN`, and `SMITHERS_WORKFLOW_*` families.

| Variable | Meaning |
| --- | --- |
| `SMITHERS_REMOTE` | The control plane to act on. The environment form of `--remote`. |
| `SMITHERS_TOKEN` | Session token override for the saved login. |
| `SMITHERS_MCP_CONFIG` | Path to the `--mcp-config` server array. |
| `SMITHERS_BACKEND` | Database backend. Only `sqlite` is supported. |
| `SMITHERS_OPENAI_AUTH` | `api-key` or `chatgpt`, selecting whether `openai` seats sign with `OPENAI_API_KEY` or with the local Codex login. Explicit `api-key` selection takes precedence over a configured account pool. Explicit `codex:<model>` seats always use the login. Smithers reads its access token from `$CODEX_HOME/auth.json` and never writes the file; the Codex CLI refreshes it. |
| `SMITHERS_SEATS` | A JSON object pinning each role seat a flow declares, such as `coding/review`, to a seat alias or an explicit `provider:model`: `{"coding/review":"sol","coding/implement":"opus"}`. The journaled seat keeps the role id. A role seat with no pin fails with `SeatUnresolved` naming this variable, and a malformed value refuses every seat. |
| `SMITHERS_TEST_COMMAND`, `SMITHERS_TEST_CONTAINER`, `SMITHERS_TEST_CWD`, `SMITHERS_TEST_TIMEOUT_MS` | What the `test` flow runs, where, and for how long. `SMITHERS_TEST_CWD` is the repository's absolute path inside the container: checkpoints pin there, and a sealed host's file flows resolve relative paths there. |
| `SMITHERS_SANDBOX_IMAGE` | The image a flow's `sandbox: {provider: container}` runs in, through `docker`. Unset refuses such flows. |
| `SMITHERS_BASH_CONTAINER` | The one container `bash` and `test` may reach, through the `docker` CLI and the host's `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_TLS_VERIFY`, and `DOCKER_CERT_PATH`. Any other `bash` call fails with `outside_container`. The file flows (`read`, `write`, `edit`, `apply_patch`, `ls`, `glob`, `grep`) act on the container's files through the same transport, under `SMITHERS_TEST_CWD`; without it the host offers no file flow. No flow reads or writes the host's files. Unset, the CLI reaches no container. |
| `SMITHERS_ASKS` | `park` or `refuse`, what an in-run `ask` does. Unset is `park`: the run waits for `smthrs approvals approve`. `refuse` is for a host nobody answers, such as a benchmark or CI lane: the ask fails at once with `ApprovalUnavailable` and the run continues. Any other value refuses to start. |
| `SMITHERS_MEMORY_DB` | Path of a separate SQLite file for the memory store. Runs that name the same file share one memory bank, and only then does the supervisor write accepted sentences to it. Without it, the bank is named after the workspace and the supervisor writes nothing. |
| `SMITHERS_SUPERVISOR_STANCE` | `careful` or `paranoid`, the stance a judged run is taught. Unset is `careful`; any other value refuses to start. |
| `SMITHERS_BUG_ENDPOINT` | Where `smthrs bug` posts its report. |
| `SMITHERS_ALERT_TELEGRAM_TOKEN` | The Telegram bot token `smthrs alerts report` pages with when `.smithers/alerts.json` names a chat. |
| `SMITHERS_ALERT_EMAIL_API_KEY` | The Resend API key `smthrs alerts report` sends email with when `.smithers/alerts.json` names addresses. |
| `SMITHERS_JJ_PATH` | Explicit path to the `jj` binary. |
| `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` | Absolute `smithers-jj-export` path for the Node and Bun hosts' filesystem helper. Unset uses the packaged or source-checkout build. `PATH` is never searched. |
| `SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS` | How long `flow start -d` waits for its child's admission line. |
| `SMITHERS_INSIDE_RUN`, `SMITHERS_RUN_ID` | Set on an agent process by the engine. Both keep their 0.x meaning. |

## HTTP proxies

The native Node control host's model HTTP transport reads `http_proxy`,
`https_proxy`, and `no_proxy`, with `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`
as fallbacks. Lowercase values take precedence, including empty strings.
`no_proxy` selects destinations that bypass the proxy. With neither proxy URL
set, the host uses its direct dispatcher. Replacement connection pools apply
the same environment policy.

An empty value is treated exactly like an unset one, because an
exported-but-blank variable is how a shell spells "not configured".
`Environment.readInteger` requires the whole value to be digits, so `30s` and
`30abc` are ignored rather than read as 30.

Provider keys are resolved by the seat resolver; `smthrs doctor` reports
availability without printing their values. Each variable also accepts a
`_FILE` variant: `ANTHROPIC_API_KEY_FILE`, `OPENAI_API_KEY_FILE`,
`OPENROUTER_API_KEY_FILE`, `MOONSHOT_API_KEY_FILE`, `GEMINI_API_KEY_FILE`,
`GOOGLE_API_KEY_FILE`, `CEREBRAS_API_KEY_FILE`, and `AI_GATEWAY_API_KEY_FILE`.
The Gateway key also configures the Jev evaluator.

Non-empty direct variables take precedence over files. For Gemini, direct
`GEMINI_API_KEY` precedes `GOOGLE_API_KEY`; only when both are empty or unset
are `GEMINI_API_KEY_FILE` then `GOOGLE_API_KEY_FILE` considered. A selected
file that cannot be read safely is refused; it never falls back to another
credential. Files must be regular, owned by the current OS account, and mode
0600 or 0400. Symlinks, empty files, multiple lines, whitespace and files over
16 KiB are refused. One trailing LF or CRLF is allowed. Hosts without POSIX
ownership checks refuse file credentials. Resolution rereads the file, so
rotation takes effect on the next resolution. Contents are not exported into
child environments, detection metadata or diagnostics.

## Saved CLI logins

`SMITHERS_AUTH_FILE` selects a credential store; its default is
`$HOME/.config/smithers/auth.json`. Native keyring entries are scoped to the
canonical file path and the complete API origin, including scheme and port.
Two stores can log in simultaneously to the same API without replacing each
other. Relative paths and symlinked parents that reach the same file share a
store. Logout clears only that store's entry.

An explicit token in the auth file takes precedence over a stale native
entry. Legacy hostname-only keyring entries are read only for an unversioned
record at the OS account's original default location, bound to the exact API
origin. Changing `HOME` or selecting another file never claims that legacy
login. Reading does not migrate or write credentials; the next explicit login
writes the scoped v2 record. Logout of an eligible legacy record also clears
its legacy entry. Custom stores never delete it.

## Planning failures

A loaded flow whose graph cannot be built or compiled fails planning with
`InvalidInput`; no empty approval plan is saved. Planning and authored rebuild
warnings retain the flow identifier and failure stage without exception content.
Load diagnostics redact the complete message before truncation. Concurrent drift
reads share one scoped disk registry without replacing the planning snapshot.
