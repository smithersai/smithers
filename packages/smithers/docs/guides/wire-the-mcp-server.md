---
title: "Wire the MCP server into an agent"
description: "Connect the canonical MCP command surface, keep approval decisions independent, and configure an explicitly delegated compatibility host."
---

`smthrs --mcp` serves the Smithers MCP server on stdio, over the same control
plane the verbs use. An agent can inspect flows, plan work, execute an already
approved plan, and observe runs. Approval decisions are excluded by default.

## Register it

```bash
smthrs mcp add --agent claude
smthrs mcp add --agent codex
smthrs mcp add                  # every agent it knows
```

`--agent` is a flag, not a positional argument. `mcp add` writes an
`mcpServers` entry named `smithers` into the agent's own configuration:

| Agent | File |
| --- | --- |
| `claude` | `~/.claude.json` |
| `codex` | `~/.codex/mcp.json` |

`smthrs mcp add` with no `--agent` wires every agent it knows. An unknown agent
name is a usage error that lists the known ids. `smthrs mcp` on its own prints
the group's help; `add` is its only subcommand.

The entry records the current executable and entry path verbatim, not a package
runner. An installed CLI therefore registers its own installed path, and a
local development install registers itself. Smithers 0.x registered
`bunx smthrs --mcp`, which silently pointed every agent at the last published
build.

The write is a temp-file-plus-rename under a lock file, with the original
file's mode preserved, so a crash mid-write cannot leave a half-written
configuration. The lock names the process holding it, so one left by a process
that has since died is reclaimed rather than blocking every later run. If the file already holds the exact entry, nothing is written
and the result says `unchanged`. Add `--json` for one array of registration results,
with `agent`, `path`, and `status` fields. Registration does not open a workspace
database. If every target fails, the command prints
manual instructions to stderr and exits 1.

## Serve it by hand

```bash
smthrs --mcp
```

`--mcp` is a mode, not a verb, because every MCP client configures a launch
command rather than a subcommand. The flag is read from the raw argument vector
before the command tree parses anything.

## Canonical tools and independent approval

The executable uses the unified command tree through Incur's MCP discovery
tools: `search_tools`, `get_tool_details`, and `call_write_tool`. Discover
canonical names such as `flow_list`, `flow_plan`, `flow_execute`, `runs_show`,
and `approvals_list`; fetch their schema before invoking them.

`approvals_approve`, `approvals_deny`, and `flow_start` are absent from both
discovery and dispatch. `flow_start` is excluded because it implicitly approves
the plan. The operator can instead review the payload and use
`smthrs approvals approve` or `smthrs approvals deny` locally. An agent can then
execute the approved plan. Changing `--audience` changes presentation, not
approval authority. MCP invocations carry the local actor `mcp/agent`.

This is an approval boundary, not an operating-system sandbox. Do not grant
arbitrary host shell, code execution, or database write access to an actor that
must not bypass a human gate.

## Compatibility hosts

The separately exported `McpServer` library retains the 0.x semantic tool names
and its `{ ok, data?, error? }` result envelope. It is not the canonical
executable's discovery protocol. Its `Options` choose `surface` (`semantic`,
`raw`, or `both`), `allowedTools`, and `readOnly`. Raw tools are shell-command
directory entries, not another execution path. An allowlist cannot enable
approval-bearing tools on its own.

`list_flows`, `list_runs`, and `list_pending_approvals` return one Control page.
Each accepts optional `cursor` and `limit` arguments. `limit` is 1 to 500 and
defaults to 100. `data` stays the array of items. When more items remain, the
envelope also carries `nextCursor`; pass it back as `cursor` to read the next
page. An envelope without `nextCursor` is the last page. `list_flows` drops
reserved system flows from each page, so a page can hold fewer than `limit`
items and still have a `nextCursor`.

The default semantic session exposes nine Control-backed tools plus ten
unsupported compatibility entries. `run_workflow` and `resolve_approval` are
excluded. A custom host can set `approvalTools: true` and a host-authenticated
`principal: { id, kind }`; that only exposes the tools. The receiving Control
runtime must independently delegate the exact identity, target kind, and scope
using `ApprovalAuthority`. Without a configured principal the actor is
`mcp/agent`, never the local operator. Tool arguments cannot choose that actor.

`resolve_approval` defaults to `once`; `run_workflow` needs `run`-scope Plan
approval. `remembered` must be explicitly delegated. See
[approval authority](/pkg/control/guides/approvals/#who-may-decide).
If a host delegates approval to an agent, describe that as automated approval,
not independent human review. When using a remote Control client, the remote
server authenticates the connection; give each trust domain its own credential
and policy rather than sharing an operator credential.

Compatibility frames are bounded to 4 MiB; history results to 10,000 events and
1 MiB. `watch_run` applies those history limits only to events after
`afterSequence` and retains the supplied cursor when the delta is empty.
`McpServer.serve` pauses input while replies are blocked, waits for each write
to complete, and returns after input EOF only once all replies have completed.
Transport errors stop the session; interruption releases its stream listeners.
These are the `McpServer` library's bounds, not a claim about Incur's
transport limits. `McpServer.unsupportedTools` and `unsupportedReasons` enumerate
the retained tools that answer `unsupported`.

## The other direction

`--mcp-config <path>` is not this feature. It names a JSON array of MCP servers
that the local executor connects at startup and projects into a run's flow
catalog, so a flow can call them. The file is an array of
`{ server, command, args, cwd?, env?, handshakeTimeoutMs?, requestTimeoutMs?,
queueCapacity?, maxFrameBytes? }` entries. A path that is missing, unreadable,
malformed, or wrongly shaped is a usage error naming the flag, never a silent
change to the executor's tool catalog.

It is meaningless under `--remote`, where the executor is not this process's to
configure.

## See also

- [`smthrs mcp`](/cli/mcp): the per-verb reference.
- [MCP setup](/docs/guides/mcp-setup/): the product guide.
- [`@smthrs/mcp`](/api/mcp): the client and the flow projection.

The retired names `list_workflows` and `run_workflow` remain tombstones: they return an `unsupported` error directing callers to `list_flows` and `run_flow`. They do not list or launch anything.
