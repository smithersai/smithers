# CLI reference

> Install discovery and additional local commands, with usage, arguments, options and defaults from the CLI's own help.

Install discovery for `smthrs` 1.0.0-rc.16, plus additional local commands, as their `--help` describes them.

Other callable library commands stay outside install discovery. Use their explicit `--help`; see the [library command reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/docs/reference/cli/README.md) and [CLI API](/docs/reference/api/cli/).

```bash
npm install -g smthrs@next
```

## Commands

| Command | Description |
| --- | --- |
| [`agent`](#agent) | Configure an agent |
| [`api`](#api) | Make raw API calls to the Smithers server |
| [`branch`](#branch) | Branches and machines |
| [`branches`](#branches) | List branches with presence |
| [`change`](#change) | Inspect local jj changes |
| [`cp`](#cp) | Copy files or directories between the local machine and a workspace |
| [`diff`](#diff) | Show a branch's changes |
| [`doctor`](#doctor) | Check project discovery, providers, tools, and durable-state compatibility |
| [`exec`](#exec) | Run a workspace command with a durable receipt and bounded output |
| [`file`](#file) | Open and co-edit a file |
| [`files`](#files) | Browse a branch's files |
| [`flow`](#flow) | Discover, plan, and start durable flows |
| [`flows`](#flows) | List the repository's flows |
| [`generate`](#generate) | Scaffold flows, packages, and CI configuration |
| [`github`](#github) | Show sync status and retry |
| [`host`](#host) | Operate this installation’s host |
| [`issue`](#issue) | Manage repository issues |
| [`issues`](#issues) | List the repository's issues |
| [`login`](#login) | Log in to Smithers |
| [`merge`](#merge) | Review and merge the next item; waits for the person's confirmation |
| [`monitor`](#monitor) | Every run, with its debug view |
| [`pr`](#pr) | Open a pull request's card |
| [`review`](#review) | Review a change, return findings; waits for the person's confirmation |
| [`run`](#run) | Advanced |
| [`runs`](#runs) | Inspect and control durable execution records |
| [`search`](#search) | Search code, wiki and runs |
| [`shell`](#shell) | Open an interactive terminal in a workspace via the WebSocket terminal endpoint |
| [`ssh`](#ssh) | Copy the SSH line for a branch |
| [`ssh-key`](#ssh-key) | Manage your SSH keys |
| [`stack`](#stack) | Show the stack and background runs |
| [`todo`](#todo) | Answer the install's TODOs |
| [`wiki`](#wiki) | Read and edit wiki pages |
| [`workspace`](#workspace) | Create, open and run commands in workspaces |
| [`tui`](#tui) | Open the terminal coding agent |

## Global options

Every command takes these options.

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--audience` | one of `auto`, `human`, `agent` | `auto` | no | Presentation audience; auto detects agent harnesses, CI, and terminals |
| `--silent` | boolean | `false` | no | Suppress progress; retain the result and actionable failures |
| `--ui` | one of `auto`, `tty`, `stream`, `plain` | `auto` | no | Terminal renderer: tty draws in place, stream colours without cursor motion, plain prints bare lines; auto shows live human progress; agent, `--silent`, pipe and dumb-terminal policies take precedence |

`smthrs --help` also lists these built-in options.

| Option | Value | Description |
| --- | --- | --- |
| `--filter-output` | `keys` | Filter output by key paths (e.g. foo,bar.baz,a\[0,3\]) |
| `--format` | `toon\|json\|yaml\|md\|jsonl` | Output format |
| `--full-output` |  | Show full output envelope |
| `--help` |  | Show help |
| `--llms`, `--llms-full` |  | Print LLM-readable manifest |
| `--mcp` |  | Start as MCP stdio server |
| `--schema` |  | Show JSON Schema for command |
| `--token-count` |  | Print token count of output (instead of output) |
| `--token-limit` | `n` | Limit output to n tokens |
| `--token-offset` | `n` | Skip first n tokens of output |
| `--update` |  | Update to latest version |
| `--version` |  | Show version |

## `agent`

Configure an agent

```text
smthrs agent <name> [options] | <command>
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | string, min length 1 |  | yes |  |

### `agent edit`

Propose an instruction change; waits for the person's confirmation

```text
smthrs agent edit <name> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | one of `planner`, `implementer`, `reviewer`, `app` |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--request` | string, min length 1 |  | yes |  |
| `--diff` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `api`

Make raw API calls to the Smithers server

```text
smthrs api <endpoint> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `endpoint` | string |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--method` | string | `GET` | no |  |
| `--field` | array of string |  | no |  |
| `--header` | array of string |  | no |  |
| `--input` | string |  | no | JSON request body from a file, or - for stdin |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `branch`

Branches and machines

```text
smthrs branch <command>
```

### `branch add-to-stack`

Add a scratch branch as a TODO; waits for the person's confirmation

```text
smthrs branch add-to-stack [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--branch` | string |  | yes |  |
| `--text` | string |  | no |  |
| `--title` | string, min length 1 |  | no |  |
| `--acceptance` | array of string |  | no |  |
| `--after` | integer, minimum 1 |  | no |  |
| `--before` | string, pattern `^T[1-9]\d*$` |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `branch archive`

Archive a scratch branch; waits for the person's confirmation

```text
smthrs branch archive [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--branch` | string |  | yes |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `branch fork`

Fork a scratch branch

```text
smthrs branch fork [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--from` | string, min length 1 |  | yes |  |
| `--name` | string, min length 1 |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `branch rebase`

Rebase this branch now

```text
smthrs branch rebase [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--branch` | string |  | yes |  |
| `--conflict_change` | string, min length 1 |  | no |  |
| `--onto_revision` | string, min length 1 |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `branch show`

Open a branch's card

```text
smthrs branch show <name> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | string |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `branches`

List branches with presence

```text
smthrs branches [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `change`

Inspect local jj changes

```text
smthrs change <command>
```

### `change diff`

Show diff for a change

```text
smthrs change diff [id] [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | string |  | no | Change ID (defaults to working copy) |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo`, `-R` | string |  | no | Repository (OWNER/REPO) |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `change list`

List changes

```text
smthrs change list [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--limit` | number | `10` | no | Number of changes to show |
| `--repo`, `-R` | string |  | no | Repository (OWNER/REPO) |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `change status`

Show working copy status

```text
smthrs change status [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `change files`

List files in a change

```text
smthrs change files <id> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | string |  | yes | Change ID |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo`, `-R` | string |  | no | Repository (OWNER/REPO) |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `change show`

Show a specific change

```text
smthrs change show <id> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | string |  | yes | Change ID |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo`, `-R` | string |  | no | Repository (OWNER/REPO) |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `change conflicts`

List conflicts in a change

```text
smthrs change conflicts <id> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | string |  | yes | Change ID |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo`, `-R` | string |  | no | Repository (OWNER/REPO) |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `cp`

Copy files or directories between the local machine and a workspace

```text
smthrs cp <src> <dst> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `src` | string |  | yes | Local path or \<workspace-id>:\<path> |
| `dst` | string |  | yes | Local path or \<workspace-id>:\<path> |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo`, `-R` | string |  | no | Repository (OWNER/REPO) |
| `--timeout` | number | `0` | no | Transfer timeout in seconds |
| `--user` | string | `developer` | no | Guest user |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `diff`

Show a branch's changes

```text
smthrs diff [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--branch` | string |  | no |  |
| `--entry` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `doctor`

Check project discovery, providers, tools, and durable-state compatibility

```text
smthrs doctor [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--root` | string |  | no | Project directory; defaults to the nearest Smithers project |
| `--remote` | string |  | no | Remote control plane URL; defaults to SMITHERS_REMOTE |
| `--mcp-config` | string |  | no | Path to the configured MCP servers |
| `--quiet` | boolean | `false` | no | Suppress progress messages |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `exec`

Run a workspace command with a durable receipt and bounded output

```text
smthrs exec [id] [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | string |  | no | Workspace ID (auto-detected if omitted) |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--command` | string |  | yes | Remote command to run (multi-line allowed; runs under bash) |
| `--cwd` | string |  | no | Working directory (default: workspace root) |
| `--detach` | boolean | `false` | no | Return the receipt at once; the command keeps running (reattach with `--exec-id`) |
| `--env` | array of string | `[]` | no | KEY=VALUE exported to the command (repeatable) |
| `--exec-id` | string |  | no | Durable command ID; reuse with the same command to reattach after a disconnect |
| `--repo`, `-R` | string |  | no | Repository (OWNER/REPO) |
| `--seed-agent-auth` | string |  | no | Disabled: host credentials cannot be seeded into workspaces |
| `--timeout` | number |  | no | Cancel after this many seconds (default: 0; server guard: 60 minutes) |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `file`

Open and co-edit a file

```text
smthrs file <path> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `path` | string |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--branch` | string |  | no |  |
| `--revision` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `files`

Browse a branch's files

```text
smthrs files [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--path` | string |  | no |  |
| `--branch` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `flow`

Discover, plan, and start durable flows

```text
smthrs flow <command>
```

### `flow edit`

Propose a change to a flow; waits for the person's confirmation

```text
smthrs flow edit <name> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | string, min length 1 |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--request` | string, min length 1 |  | yes |  |
| `--diff` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `flow new`

Create a new flow; waits for the person's confirmation

```text
smthrs flow new [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--description` | string |  | yes |  |
| `--repo` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `flow plan`

See what a flow would run

```text
smthrs flow plan <flow> <input...> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `flow` | string, min length 1 |  | yes | Discovered flow name |
| `input` | array of string | `[]` | no | Input fields as key=value |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--root` | string |  | no | Project directory; defaults to the nearest Smithers project |
| `--remote` | string |  | no | Remote control plane URL; defaults to SMITHERS_REMOTE |
| `--mcp-config` | string |  | no | Path to the configured MCP servers |
| `--quiet` | boolean | `false` | no | Suppress progress messages |
| `--data` | string |  | no | JSON input object |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |
| `--repo` | string |  | no |  |
| `--source-card` | string |  | no |  |
| `--against` | string |  | no |  |
| `--input` | object |  | no |  |

### `flow run`

Run a flow with typed input

```text
smthrs flow run <name> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | string |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo` | string |  | no |  |
| `--source-card` | string |  | no |  |
| `--workspace-id` | string |  | no |  |
| `--input` | object |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `flow show`

Show a flow's steps and versions

```text
smthrs flow show <flow> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `flow` | string, min length 1 |  | yes | Discovered flow name |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--root` | string |  | no | Project directory; defaults to the nearest Smithers project |
| `--remote` | string |  | no | Remote control plane URL; defaults to SMITHERS_REMOTE |
| `--mcp-config` | string |  | no | Path to the configured MCP servers |
| `--quiet` | boolean | `false` | no | Suppress progress messages |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `flow source`

Co-edit a flow's source

```text
smthrs flow source <name> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | string, min length 1 |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `flow start`

Plan, approve, and start one flow; optionally detach after durable admission

```text
smthrs flow start <flow> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `flow` | string, min length 1 |  | yes | Discovered flow name |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--input` | array of string | `[]` | no | Input key=value pairs (can be repeated) |
| `--ref` | string | `main` | no | Git ref to run against |
| `--repo`, `-R` | string |  | no | Repository (OWNER/REPO) |
| `--root` | string |  | no | Project directory; defaults to the nearest Smithers project |
| `--remote` | string |  | no | Remote control plane URL; defaults to SMITHERS_REMOTE |
| `--mcp-config` | string |  | no | Path to the configured MCP servers |
| `--quiet` | boolean | `false` | no | Suppress progress messages |
| `--data` | string |  | no |  |
| `--detached`, `-d` | boolean | `false` | no |  |
| `--wait` | boolean | `false` | no | Wait for the run's status before exiting |
| `--budget-tokens` | integer, greater than 0 |  | no | Token ceiling for this run |
| `--budget-ms` | integer, greater than 0 |  | no | Wall-clock ceiling in milliseconds for this run |
| `--budget-usd` | number, greater than 0 |  | no | Dollar ceiling for this run |
| `--on-exceeded` | one of `fail`, `warn`, `skip-remaining`, `park` |  | no | What the run does at a ceiling |
| `--deadline` | string |  | no | Wall-clock time the run may take from its first start, as a duration (30 minutes) or milliseconds |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |
| `--cloud` | boolean | `false` | no | Use repository flows and runs on the backend |

## `flows`

List the repository's flows

```text
smthrs flows [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `generate`

Scaffold flows, packages, and CI configuration

```text
smthrs generate <command>
```

### `generate flow`

Create a tagged TypeScript flow without replacing an existing flow

```text
smthrs generate flow <name> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | string, min length 1 |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--root` | string |  | no | Project directory |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `generate package`

Run the workspace's declared package scaffold with its configured defaults

```text
smthrs generate package <name> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | string, min length 1 |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--workspace` | string | `<cwd>` | no |  |
| `--target` | string |  | no | Declared generator label; required when more than one matches |
| `--plan` | boolean | `false` | no | Show the generator plan without writing files |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `generate ci`

Generate CI files using the workspace's declared GitHub workflow target

```text
smthrs generate ci [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--workspace` | string | `<cwd>` | no |  |
| `--target` | string |  | no | Declared generator label; required when more than one matches |
| `--plan` | boolean | `false` | no | Show the generator plan without writing files |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `github`

Show sync status and retry

```text
smthrs github [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `host`

Operate this installation’s host

```text
smthrs host <command>
```

### `host backup`

Back up the installation

```text
smthrs host backup [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `host restore`

Restore the installation from a verified backup

```text
smthrs host restore <directory> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `directory` | string |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `host start`

Start the bundled host service

```text
smthrs host start [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--bundle` | string |  | no | Built server bundle directory |
| `--bind` | string |  | no |  |
| `--origin` | array of string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `host status`

Show launchd, bundle and process health

```text
smthrs host status [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `host stop`

Stop the host service

```text
smthrs host stop [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `host upgrade`

Upgrade the installation after a verified backup

```text
smthrs host upgrade [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `issue`

Manage repository issues

```text
smthrs issue <command>
```

### `issue comment`

Comment on an issue; waits for the person's confirmation

```text
smthrs issue comment <number> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `number` | string |  | yes | Issue number |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--body` | string, min length 1 |  | yes |  |
| `--repo` | string |  | no | Repository (OWNER/REPO) |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `issue new`

Open a GitHub issue; waits for the person's confirmation

```text
smthrs issue new [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--title` | string, min length 1 |  | yes |  |
| `--body` | string |  | yes |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `issue show`

Open an issue's card

```text
smthrs issue show <number> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `number` | number or one of `Infinity`, `-Infinity`, `NaN` |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `issues`

List the repository's issues

```text
smthrs issues [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `login`

Log in to Smithers

```text
smthrs login [origin] [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `origin` | string |  | no | Install origin |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--admin` | boolean | `false` | no | Request an expiring administrator token with browser consent |
| `--host` | string |  | no | Hostname or API URL (alias for `--hostname`) |
| `--hostname` | string |  | no | Hostname or API URL to authenticate with |
| `--observe` | boolean | `false` | no | Sign in as an administrator and open Observe already authenticated |
| `--agent` | string, pattern `^[a-z0-9-]{1,32}$` |  | no | External agent name |
| `--ttl` | string |  | no | Admin token lifetime (5m to 12h; default 1h) |
| `--with-token` | boolean | `false` | no | Read token from stdin instead of browser flow |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `merge`

Review and merge the next item; waits for the person's confirmation

```text
smthrs merge <n> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `n` | string, pattern `^T[1-9]\d*$` |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--reviewed_head_sha` | string |  | no |  |
| `--idempotency-key` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `monitor`

Every run, with its debug view

```text
smthrs monitor [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `pr`

Open a pull request's card

```text
smthrs pr <number> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `number` | integer, greater than 0 |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `review`

Review a change, return findings; waits for the person's confirmation

```text
smthrs review <patterns...> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `patterns` | array of string, min items 1 |  | yes | Bazel labels or recursive patterns; the verb runs their union |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--workspace` | string | `<cwd>` | no | Directory inside a workspace containing WORKSPACE.ts |
| `--cache-dir` | string |  | no | Workspace-relative cache directory; overrides the WORKSPACE.ts declaration |
| `--policy-revision` | string |  | no | Full approved commit SHA containing the trusted review index |
| `--revision` | string | `HEAD` | no | Committed source revision: HEAD or a full commit SHA |
| `--plan` | boolean | `false` | no | Show pinned policy and source selection without inference |
| `--required` | boolean | `false` | no | Fail every selected review that selects no files or cannot run instead of passing it |
| `--findings-store` | string |  | no | Absolute private directory for review runs and findings (default: the Git directory) |
| `--credential-receiver` | string |  | no | Absolute executable that receives credential names and locations as JSON on stdin; a nonzero exit fails the review |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |
| `--repo` | string |  | no |  |

## `run`

Advanced

```text
smthrs run <command>
```

### `run inspect`

Open a run's monitor

```text
smthrs run inspect <id> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | string |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `runs`

Inspect and control durable execution records

```text
smthrs runs <command>
```

### `runs list`

Active and attention-needing runs

```text
smthrs runs list [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo` | string |  | no | Repository (OWNER/REPO) |
| `--root` | string |  | no | Project directory; defaults to the nearest Smithers project |
| `--remote` | string |  | no | Remote control plane URL; defaults to SMITHERS_REMOTE |
| `--mcp-config` | string |  | no | Path to the configured MCP servers |
| `--quiet` | boolean | `false` | no | Suppress progress messages |
| `--flow` | string |  | no |  |
| `--status` | one of `accepted`, `running`, `parked`, `waiting-approval`, `cancelled`, `completed`, `failed` |  | no |  |
| `--since` | string |  | no | Only runs created at or after this time (epoch ms or ISO 8601) |
| `--until` | string |  | no | Only runs created before this time (epoch ms or ISO 8601) |
| `--sort` | one of `newest`, `oldest` |  | no | Order by creation time |
| `--parent` | string |  | no | Only runs branched from this run |
| `--trigger` | string |  | no | Only runs this trigger started |
| `--limit` | integer, minimum 1, maximum 500 |  | no | Runs per page (default 100) |
| `--cursor` | string |  | no | Continue from the nextCursor a previous page printed |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |
| `--cloud` | boolean | `false` | no | Use repository flows and runs on the backend |

### `runs resume`

Resume a parked durable run

```text
smthrs runs resume <run> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `run` | string, min length 1 |  | yes | Durable run ID |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--root` | string |  | no | Project directory; defaults to the nearest Smithers project |
| `--remote` | string |  | no | Remote control plane URL; defaults to SMITHERS_REMOTE |
| `--mcp-config` | string |  | no | Path to the configured MCP servers |
| `--quiet` | boolean | `false` | no | Suppress progress messages |
| `--allow-code-drift` | boolean | `false` | no | Resume even though the run's flow changed since it started |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `runs show`

Open a run's card

```text
smthrs runs show <run> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `run` | string, min length 1 |  | yes | Durable run ID |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo` | string |  | no | Repository (OWNER/REPO) |
| `--root` | string |  | no | Project directory; defaults to the nearest Smithers project |
| `--remote` | string |  | no | Remote control plane URL; defaults to SMITHERS_REMOTE |
| `--mcp-config` | string |  | no | Path to the configured MCP servers |
| `--quiet` | boolean | `false` | no | Suppress progress messages |
| `--timing` | boolean | `false` | no | Report where the run's time and tokens went |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |
| `--cloud` | boolean | `false` | no | Use repository flows and runs on the backend |

## `search`

Search code, wiki and runs

```text
smthrs search [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--query` | string |  | no |  |

## `shell`

Open an interactive terminal in a workspace via the WebSocket terminal endpoint

```text
smthrs shell [id] [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | string |  | no | Workspace ID (auto-detected if omitted) |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--cols` | number | `0` | no | Initial terminal columns (0 = detect) |
| `--repo`, `-R` | string |  | no | Repository (OWNER/REPO) |
| `--rows` | number | `0` | no | Initial terminal rows (0 = detect) |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `ssh`

Copy the SSH line for a branch

```text
smthrs ssh <branch> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `branch` | string |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `ssh-key`

Manage your SSH keys

```text
smthrs ssh-key <command>
```

### `ssh-key add`

Add an SSH key

```text
smthrs ssh-key add [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--title` | string |  | yes | Key title |
| `--key` | string |  | yes | Public key content |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `ssh-key delete`

Delete an SSH key

```text
smthrs ssh-key delete <id> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | string |  | yes | Key ID |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `ssh-key list`

List SSH keys

```text
smthrs ssh-key list [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `stack`

Show the stack and background runs

```text
smthrs stack [options] | <command>
```

### `stack move`

Reorder an item

```text
smthrs stack move <n> <direction> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `n` | string, pattern `^T[1-9]\d*$` |  | yes |  |
| `direction` | one of `up`, `down` |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `todo`

Answer the install's TODOs

```text
smthrs todo <command>
```

### `todo amend`

Change an unmerged TODO's prompt; waits for the person's confirmation

```text
smthrs todo amend <n> <text> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `n` | string, pattern `^T[1-9]\d*$` |  | yes |  |
| `text` | string, min length 1 |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--acceptance` | array of string |  | no |  |
| `--card-id` | string |  | no |  |
| `--idempotency-key` | string, min length 1 |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `todo answer`

Answer the agent's question

```text
smthrs todo answer <todo> <answer> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `todo` | string, pattern `^T[1-9]\d*$` |  | yes | TODO number (T3) |
| `answer` | string |  | yes | Your answer |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--wait` | string |  | no | The question's id, when the TODO asks more than one |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `todo drop`

Abandon an unmerged TODO; waits for the person's confirmation

```text
smthrs todo drop <n> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `n` | string, pattern `^T[1-9]\d*$` |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `todo from-issue`

Draft a TODO from an issue; waits for the person's confirmation

```text
smthrs todo from-issue <number> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `number` | number or one of `Infinity`, `-Infinity`, `NaN` |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `todo new`

Write and place a TODO; waits for the person's confirmation

```text
smthrs todo new [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--text` | string |  | no |  |
| `--title` | string, min length 1 |  | no |  |
| `--acceptance` | array of string |  | no |  |
| `--before` | string, pattern `^T[1-9]\d*$` |  | no |  |
| `--card-id` | string |  | no |  |
| `--idempotency-key` | string, min length 1 |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `todo resume`

Resume a paused TODO

```text
smthrs todo resume <n> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `n` | string, pattern `^T[1-9]\d*$` |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `todo retry`

Retry a failed TODO

```text
smthrs todo retry <n> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `n` | string, pattern `^T[1-9]\d*$` |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--text` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `todo show`

Open a TODO

```text
smthrs todo show <n> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `n` | string, pattern `^T[1-9]\d*$` |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `todo steer`

Send the agent a correction

```text
smthrs todo steer <n> <text> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `n` | string, pattern `^T[1-9]\d*$` |  | yes |  |
| `text` | string, min length 1 |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--idempotency-key` | string, min length 1 |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `todo stop`

Pause a working TODO

```text
smthrs todo stop <n> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `n` | string, pattern `^T[1-9]\d*$` |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `wiki`

Read and edit wiki pages

```text
smthrs wiki <command>
```

### `wiki page`

Open or create a page

```text
smthrs wiki page <name> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | string, min length 1 |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--owner` | string, min length 1 |  | yes |  |
| `--repo` | string, min length 1 |  | yes |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `wiki save`

Save this answer as a page

```text
smthrs wiki save <name> [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `name` | string, min length 1 |  | yes |  |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--text` | string |  | no |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### `wiki show`

Open the wiki

```text
smthrs wiki show [options]
```

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--owner` | string, min length 1 |  | yes |  |
| `--repo` | string, min length 1 |  | yes |  |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `workspace`

Create, open and run commands in workspaces

```text
smthrs workspace <command>
```

### `workspace ssh`

SSH into a workspace (creates one if none exists for the repo)

```text
smthrs workspace ssh [id] [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `id` | string |  | no | Workspace ID (auto-detected if omitted) |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--repo`, `-R` | string |  | no | Repository (OWNER/REPO) |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

## `tui`

Open the terminal coding agent

```text
smthrs tui [directory] [options]
```

| Argument | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `directory` | string |  | no | Working directory; defaults to cwd |

| Option | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `--model`, `-m` | string |  | no | Chat seat as provider:model |
| `--continue`, `-c` | boolean | `false` | no | Continue the latest session in the directory |
| `--resume`, `-r` | boolean | `false` | no | Pick a session to continue |
| `--print`, `-p` | string |  | no | Answer one prompt, print it, and exit |
| `--approve` | one of `all`, `ask`, `deny` |  | no | Consequential calls: all, ask, or deny |
| `--budget-tokens` | string |  | no | Override the token ceiling per turn and worker |
| `--environment` | string |  | no | Run the TUI app in a saved execution environment |
| `--verbose` | boolean | `false` | no | Show redacted diagnostic details |

### Token budgets

`smthrs tui [directory]` opens the terminal coding agent. `--model provider:model` selects the chat model; `--continue` continues the latest session, `--resume` picks one, and `--print <prompt>` answers once and exits. `--environment <name>` runs the TUI in a saved execution environment.

| Setting | Default | Scope |
| --- | --- | --- |
| `--budget-tokens <n>` or `SMITHERS_TUI_BUDGET_TOKENS` | `200000000` | Each chat turn and worker |
| `SMITHERS_TUI_BUDGET_DAILY_TOKENS` | `2000000000` | All runs per UTC day on the execution machine |

The per-run flag wins over its environment variable. Values are positive whole numbers; `0` or `none` disables a cap. A hit stops new model calls and shows the reached cap. These are runaway-loop tripwires, not a billing limit. The outer `smthrs tui` command has no daily-budget flag; set the daily environment variable.

## `completions`

```text
smthrs completions — Generate shell completion script

Usage: smthrs completions <bash|fish|nushell|zsh>

Arguments:
  shell  Shell to generate completions for

Setup:
  bash     eval "$(smthrs completions bash)"  # add to ~/.bashrc
  fish     smthrs completions fish | source   # add to ~/.config/fish/config.fish
  nushell  see `smthrs completions nushell`   # add to config.nu
  zsh      eval "$(smthrs completions zsh)"   # add to ~/.zshrc
```

## `mcp`

```text
smthrs mcp — Register as MCP server

Usage: smthrs mcp <command>

Commands:
  add     Register as MCP server
  doctor  Validate MCP server startup and tool listing

Global Options:
  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
  --format <toon|json|yaml|md|jsonl>  Output format
  --full-output                       Show full output envelope
  --help                              Show help
  --llms, --llms-full                 Print LLM-readable manifest
  --schema                            Show JSON Schema for command
  --token-count                       Print token count of output (instead of output)
  --token-limit <n>                   Limit output to n tokens
  --token-offset <n>                  Skip first n tokens of output
```

```text
smthrs mcp add — Register with Claude Code or Codex; omit --agent to configure both

Usage: smthrs mcp add [options]

Options:
  --root <string>        Project directory; defaults to the nearest Smithers project
  --remote <string>      Remote control plane URL; defaults to SMITHERS_REMOTE
  --mcp-config <string>  Path to the configured MCP servers
  --quiet                Suppress progress messages
  --agent <string>
  --verbose              Show redacted diagnostic details

Custom Global Options:
  --audience <auto|human|agent>   (default: auto)
  --silent
  --ui <auto|tty|stream|plain>    (default: auto)

Global Options:
  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
  --format <toon|json|yaml|md|jsonl>  Output format
  --full-output                       Show full output envelope
  --help                              Show help
  --llms, --llms-full                 Print LLM-readable manifest
  --schema                            Show JSON Schema for command
  --token-count                       Print token count of output (instead of output)
  --token-limit <n>                   Limit output to n tokens
  --token-offset <n>                  Skip first n tokens of output
```

```text
smthrs mcp doctor — Validate MCP server startup and tool listing

Usage: smthrs mcp doctor
```

## `skills`

```text
smthrs skills — Sync skill files to agents

Usage: smthrs skills <command>
Aliases: skill

Commands:
  add   Sync skill files to agents
  list  List skills

Global Options:
  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
  --format <toon|json|yaml|md|jsonl>  Output format
  --full-output                       Show full output envelope
  --help                              Show help
  --llms, --llms-full                 Print LLM-readable manifest
  --schema                            Show JSON Schema for command
  --token-count                       Print token count of output (instead of output)
  --token-limit <n>                   Limit output to n tokens
  --token-offset <n>                  Skip first n tokens of output
```

```text
smthrs skills add — Sync skill files to agents

Usage: smthrs skills add [options]

Options:
  --depth <number>  Grouping depth for skill files (default: 1)
  --no-global       Install to project instead of globally
```

```text
smthrs skills list — List skills

Usage: smthrs skills list
Aliases: ls
```
