---
title: "@smthrs/cli"
description: "The smthrs command line and embeddable control library: plan, approve, execute, and inspect durable agent runs."
---

`@smthrs/cli` provides `smthrs` (and its `smithers` alias), the command line and embeddable Node library for Smithers' durable control plane.

A long agent run outlives the terminal that launched it, pauses to ask human approval before consequential actions, and must explain which step failed and what already succeeded. Smithers persists runs, plans, approvals, and events in two SQLite files (`.flows/control.db` and `.flows/engine.db`) beside your repository, turning agent execution into an auditable record rather than terminal scrollback.

```text
  [Shell]    [CI --json]    [smthrs --mcp]    [Embedded Node Host]
     |            |               |                    |
     +------------+---------------+--------------------+
                                  |
                                  v
                       +---------------------+
                       |     smthrs CLI      |
                       +---------------------+
                         |                 |
         local workspace |                 | --remote https://host:3000
                         v                 v
         .flows/control.db &        Workspace Gateway
         .flows/engine.db           (/rpc, /projections, /sync)
```

Flow control, run management, and approvals work against a remote gateway with `--remote https://host:3000`. Target execution and local-only verbs (`history`, `memory`, `triggers`, `credentials`, `integrations`, `eval`) operate strictly on the local workspace and refuse `--remote`.

## Install

```bash
npm install -g smthrs@next
```

Requires Node.js 22.19.0 or later. See [Installation](./installation.md) for subscription logins, TUI setup, and workspace target installs.

## Minimal end-to-end example

Scaffold a flow, plan it without side effects, approve the plan payload, execute it, and list the recorded run:

```bash
smthrs init hello
smthrs flow list
approval="$(smthrs flow plan hello --json | jq -c '.approval')"
smthrs approvals approve "$approval" --scope run --json
smthrs flow execute "$approval" --json
smthrs runs list
```

`flow plan` creates no run; its `approval` field is the exact payload accepted by `approvals approve`, `approvals deny`, and `flow execute`. When no separate approval step is needed, `smthrs flow start hello` collapses all three into one command. Follow [Quickstart](./quickstart.md) for the full walkthrough.

## Modes and command groups

The executable dispatches into one of three modes before parsing subcommands:

| Invocation | Behavior |
| --- | --- |
| `smthrs --help`, `smthrs --version` | Prints help or version. Opens no workspace and touches no database. |
| `smthrs --mcp` | Runs the stdio MCP server over the same control plane. |
| `smthrs <verb> ...` | Executes one command against the local or `--remote` control plane. |

Verbs grouped by job (full `--help`-generated reference in [CLI reference](./reference/cli/README.md)):

| Job | Commands |
| --- | --- |
| Plan and launch | `flow list`, `flow plan`, `flow start`, `flow execute`, `runs resume` |
| Decide approvals | `approvals list`, `approvals approve`, `approvals deny` |
| Steer live runs | `runs signal`, `runs steer` |
| Stop runs | `runs cancel`, `runs cancel-all` |
| Inspect history | `runs list`, `runs show`, `runs logs`, `runs output` |
| Initialize and check | `init`, `suggest`, `doctor`, `migrate` |
| Host and integrate | `serve`, `mcp` |
| Maintain | `gc`, `memory`, `update`, `bug`, `completions` |

Removed 0.x commands and flags fail with a single-line explanation and migration anchor rather than a generic parser error. See [The command surface](./concepts/command-surface.md).

## Library namespaces

Import every module from `@smthrs/cli` or directly from `@smthrs/cli/<Module>` (complete signatures in [API reference](./api.md); embedding guide in [Embed the command tree](./guides/embed-the-command-tree.md)):

| Namespace | Responsibility |
| --- | --- |
| `Command` | Effect CLI command tree (every shipped verb and every 0.x refusal) |
| `NodeControl` | Full Node host layer: config, registry, engine, executor, output, gateway |
| `Application` | Transport-neutral composition switching local control vs. RPC client from `Config` |
| `Output`, `Ui` | Deterministic rendering, exit-code mapping, and TTY/plain-line terminal output |
| `CliError` | The five CLI error types (including HTTP status refusals) and their exit codes |
| `CloudSession` | Authenticated Cloud requests and strict 401/403 auth-refusal detection |
| `Verb`, `Unsupported` | Closed catalogs of shipped verbs and removed 0.x spellings |
| `Project`, `Environment` | Workspace root resolution and closed environment-variable contract |
| `Detached` | `flow start -d` child launch and admission handshake |
| `Doctor`, `Forensics`, `NodeOutput`, `Legacy` | Readiness checks, run diagnosis, node outputs, and 0.x database guard |
| `Agents`, `Serve` | `mcp add` agent config writers; gateway bind rules, mounts, and banner |
| `Init`, `Suggest`, `Providers` | Scaffolding, guided suggestions, and available model seats |
| `Gc`, `Update`, `Bug`, `ClaudeMirror`, `ExecutorOwnership`, `Version` | Retention, registry checks, bug reports, legacy mirror protocol, leases, version |

## Underlying packages

Installing `@smthrs/cli` installs the full stack below. Import any package directly when building without the CLI:

| Package | Role |
| --- | --- |
| [`@smthrs/control`](/api/control) | Control plane: plans, approvals, runs, events, RPC projections |
| [`@smthrs/flow`](/api/flow) | Flow authoring model: flows, actions, waits, retry policies |
| [`@smthrs/engine`](/api/engine) | Durable execution runtime and HTTP/RPC transports |
| [`@smthrs/flows`](/api/flows) | Single barrel re-exporting the durable flow engine |
| [`@smthrs/agent`](/api/agent) | Production agent loop, `AgentSession`, and `AgentAction` |
| [`@smthrs/model`](/api/model) | Schema-first model protocols, seats, and streaming events |
| [`@smthrs/memory`](/api/memory) | Durable cross-run facts backing `smthrs memory` |
| [`@smthrs/journal`](/api/journal) | Immutable event log with write-time redaction |
| [`@smthrs/plan`](/api/plan) | Keyed action graph, append-only plan store, and plan diff |
| [`@smthrs/kernel`](/api/kernel) | Capability kernel confining filesystem, process, and network access |
| [`@smthrs/gateway`](/api/gateway) | Workspace gateway server (`smthrs serve`) and live projections |
| [`@smthrs/mcp`](/api/mcp) | MCP client projecting remote tools into flow bindings |
| [`@smthrs/migrate`](/api/migrate) | 0.x-to-1.0 project migration with auditable reports |
| [`@smthrs/testing`](/api/testing) | Flow testing and conformance utilities |

## Where to go next

- [Installation](./installation.md) and [Quickstart](./quickstart.md)
- Concepts: [command surface](./concepts/command-surface.md), [project and state](./concepts/project-and-state.md), [local and remote](./concepts/local-and-remote.md), [output and exit codes](./concepts/output-and-exit-codes.md)
- Guides: [script the CLI](./guides/script-the-cli.md), [launch a detached run](./guides/launch-a-detached-run.md), [diagnose a run](./guides/diagnose-a-run.md), [serve the workspace gateway](./guides/serve-the-workspace-gateway.md), [wire the MCP server](./guides/wire-the-mcp-server.md), [embed the command tree](./guides/embed-the-command-tree.md)
- Reference: [CLI reference](./reference/cli/README.md) and [Troubleshooting](./troubleshooting.md)

### Legacy Claude mirror subscriptions

The deprecated mirror overlays per-subscription records from `.entries` onto existing `claude-mirror-subscriptions.json` snapshots. Updates atomically replace only the caller's entry (never restoring unrelated removals), refreshes reuse records, TTL buckets bound storage, damaged records do not hide siblings, and concurrent writes to one subscription use last-replacement-wins.
