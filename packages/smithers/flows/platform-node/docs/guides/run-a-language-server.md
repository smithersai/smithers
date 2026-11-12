---
title: "Run a language server"
description: "Bind @smthrs/std's LanguageServer to host language-server processes with NodeLanguageServer: one server per language, lazy start, the workspace-program refusals, diagnostics timing, and the bounds the client enforces."
---

`NodeLanguageServer` binds [`@smthrs/std`](/api/std)'s `LanguageServer`
service to language-server processes on the host. The `lsp` flow and the
`edit`, `write`, and `apply_patch` flows call that service. The client speaks
framed JSON-RPC over ordinary stdio pipes, spawned through
[`@smthrs/kernel`](/api/kernel)'s `ChildProcessSpawner`. No terminal is
involved. It reads the host's files, paths, and environment through Node, so it
lives in this package rather than in `@smthrs/std`; Bun runs it unchanged.

For the flow side, the ten operations and their coordinates, see
[Query a language server](../../../../agent/std/docs/guides/query-a-language-server.md).

## Spawn a server

```ts
import { NodeLanguageServer } from "@smthrs/platform-node"

const server = NodeLanguageServer.layer({
  command: "typescript-language-server",
  args: ["--stdio"],
  cwd: "/workspace",
  environment: { NODE_ENV: "development" },
  timeoutMs: 30_000
})
```

The layer requires a `ChildProcessSpawner`, which `NodeHost.layer` provides. It
sends `initialize` with `cwd` as the root URI and then `initialized`, so the
service is ready when the layer is built. `timeoutMs` defaults to 30 seconds
and bounds every request as well as every write to the server's standard input.
The child inherits only `PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TERM`,
`TMPDIR`, and `SHELL`, with credential-shaped names withheld. Declare other
names through `environment`; explicit values override the allowlist.

### Keep the server's code out of the workspace

The server runs on the host as the host user, so a program the workspace
supplies would let files an agent wrote choose what the host executes. The
layer fails with `permission_denied`, before spawning, when:

- `command` resolves to a file under `cwd`, directly, through a `PATH` entry
  such as `node_modules/.bin`, or through a symlink planted there;
- an argument, or the value after `=` in one, names an existing file or
  directory under `cwd` (`node <dir>` runs that directory's `index.js` or its
  package `main`);
- `command` is a launcher whose arguments or working directory choose what
  runs: a shell (`sh -c ...`, `bash`, `zsh`), `env`, a package or tool runner
  (`npx`, `pnpm exec`, `npm`, `yarn`, `bunx`, `bun`, `deno`, `tsx`,
  `corepack`, `bundle exec`, `uv`, `uvx`, `pipx`, `poetry`, `mise`, `nix`,
  `make`, `cargo`), or a command wrapper (`nice`, `timeout`, `nohup`,
  `stdbuf`, `xargs`, `sudo`, `arch`). `npx` and `pnpm exec` resolve the
  workspace's `node_modules/.bin` first, `bun` preloads what the workspace's
  `bunfig.toml` names, and a wrapper runs whatever command follows it;
- `command` is an interpreter (`node`, `python`, `ruby`, `perl`, versioned
  names included) with no existing script file, or given code or a module
  before it: `-e`, `-p`, `-r`, `--import`, `--loader` or `--run` to `node`,
  `-m` or `-c` to `python`, `-e`, `-r` or `-S` to `ruby`, `-e` or `-M` to
  `perl`, alone or in a cluster such as `-pe`. A flag that takes the next
  argument as its value (`python -X <file>`, `node --title <file>`) does not
  make that argument the script. `python -m pylsp` imports from `cwd` first,
  so a planted `pylsp.py` would run, and inline code resolves bare requires
  from `cwd`.

Name the server's own host binary, or an interpreter and a host script file,
instead.

The layer cannot see what the server loads after it starts. By default
typescript-language-server runs the workspace's own `node_modules/typescript`;
tsserver started with `--allowLocalPluginLoads` loads `tsconfig` plugins from
the project; rust-analyzer runs build scripts and proc macros. Pin those to
host copies, or run the server in a sandbox:

```ts
import { NodeLanguageServer } from "@smthrs/platform-node"

const server = NodeLanguageServer.layer({
  command: "/opt/lsp/node_modules/.bin/typescript-language-server",
  args: ["--stdio"],
  cwd: "/workspace",
  initializationOptions: { tsserver: { path: "/opt/lsp/node_modules/typescript/lib/tsserver.js" } }
})
```

`initializationOptions` is sent on `initialize` unchanged. With `tsserver.path`
outside the workspace and local plugin loads left off, tsserver probes for
plugins only beside its own install.

### One server per language

Pass several configs and each file goes to the server whose `extensions`
include its extension. A config without `extensions` takes every file no other
server claims; a file nobody claims fails with `unsupported`.
`workspaceSymbols` asks every server and concatenates the answers.

```ts
import { NodeLanguageServer } from "@smthrs/platform-node"

const servers = NodeLanguageServer.layer([
  {
    command: "/opt/lsp/bin/typescript-language-server",
    args: ["--stdio"],
    cwd: "/workspace",
    extensions: [".ts", ".tsx"]
  },
  { command: "/opt/lsp/bin/pyright-langserver", args: ["--stdio"], cwd: "/workspace", extensions: [".py"] }
])
```

`NodeLanguageServer.layerLazy` takes the same configs but starts each server on
the first request for one of its files, so a host can bind servers a run may
never need. The workspace checks above still run when the layer is built. A
server starts with the services and permissions of the code that built the
layer, not those of the request that first needs it. A server that fails to
start fails that request and every later one for its files. `refresh` and
`close` never start a server.

## Diagnostics

`diagnostics` pulls `textDocument/diagnostic`. A server that answers
`MethodNotFound` is read from its `textDocument/publishDiagnostics`
notifications instead: the client opens the file if it is not open yet and
waits up to `settleMs` (5 seconds by default) for a publish for the latest
synced text, then fails with `timeout`. After a publish it keeps waiting while
later ones arrive less than `quietMs` (300 ms by default) apart, within
`settleMs`, and answers with the last. Either way the answer is a report,
`{ kind: "full", items }`.

A publish that carries no version counts for the text synced before it arrived.
Before each sync the client sends a `$/` request, which the specification has
every server refuse at once, so a report the server wrote earlier (such as the
empty one typescript-language-server publishes when a file closes) reaches the
client first and never counts for the new text. A server that does not answer
within a second is not asked again.

### typescript-language-server

typescript-language-server 6 has no pull diagnostics, publishes without
versions, and publishes nothing for a change that leaves a file with no
problems, so such a change always waits the full `settleMs` and fails with
`timeout`. On the first open of a file it publishes syntax errors before
semantic ones. Pick `settleMs` and `quietMs` from a measurement on your host.
From this package's directory:

```sh
node scripts/lsp-settle-bench.ts <typescript-language-server or gopls> <tsserver.js or -> <workspace> <iterations> <settleMs> <quietMs> <file>...
```

### Measured settle with real servers

Repeat the measurement with
`sh scripts/lsp-real.sh <dir> [iterations] [settleMs] [quietMs]`. It installs
typescript-language-server 6.0.1 with typescript 5.9.3 (typescript 7 ships no
`tsserver.js`) and, when Go is on `PATH`, gopls under `<dir>`. It then runs
`test/NodeLanguageServerReal.test.ts`, a real server on `test/fixtures/lsp/ts`
that is skipped when no server is on `PATH` or named by `SMITHERS_LSP_TLS` and
`SMITHERS_LSP_TSSERVER`, and writes `<dir>/out/ts.json` and `go.json`. Each
file is opened with a type error, then cycles fix, comment-only change,
restore, break, close and reopen, 5 times, at `settleMs` 3000 and `quietMs` 500.

One run on a 14 CPU macOS host at load average 44 to 54, from other agents, on
the two-file fixtures. Milliseconds from sync to the first publish (raw, p50
and max), and to the client's answer:

| Server, step                 | First publish        | Client answer            | Correct                  |
| ---------------------------- | -------------------- | ------------------------ | ------------------------ |
| tls, fix                     | 377 to 623, max 1301 | 878 to 908, max 3010     | 9/10                     |
| tls, break                   | 373 to 401, max 472  | 874 to 887, max 1202     | 10/10                    |
| tls, reopen                  | 1 to 4, max 33       | 864 to 871, max 930      | 10/10                    |
| tls, comment-only or restore | none                 | waits `settleMs` (3.0 s) | 1/20, no errors returned |
| tls, cold open               | none in 4 s          | 3.0 s, `timeout`         | 0/2                      |
| gopls, every step            | 2 to 5, max 24       | 1 to 3, max 6            | 50/50                    |
| gopls, cold open             | 252 to 1541          | 415 to 553               | 2/2                      |

`settleMs: 3000` and `quietMs: 500` hold for warm typescript-language-server
edits. Limitations: one host, loaded, n of 5 per step and 2 files; a cold open
under load exceeded 3 s for both files, and a change that leaves a file clean
returns no `errors` after the full `settleMs`. gopls publishes within
milliseconds, so it never needs more than the defaults. No Python server was
measured. The raw JSON is written by the script and is not checked in.

## Bounds a server cannot exceed

The client refuses a malformed or oversized stream rather than growing without
limit:

| Bound                                     | Value                                               |
| ----------------------------------------- | --------------------------------------------------- |
| One JSON-RPC frame body                   | 8 MiB                                               |
| One frame's headers                       | 8 KiB                                               |
| `NodeLanguageServer.MAX_QUEUED_FRAMES`    | 256 frames buffered for the server's standard input |
| `NodeLanguageServer.MAX_PENDING_REQUESTS` | 512 concurrent in-flight requests                   |

Every queued write uses the request timeout, so a server that stops reading
produces a typed `timeout` rather than an unbounded queue or a new hang.
Process exit or a closed stdout fails every pending request after at most
100 ms for stderr to finish draining.

Request errors include the protocol `method`. A server refusal keeps its
numeric code, message, and optional data in `StdError.rpcError`; the response
frame limit bounds that data. The main error message also includes the server
message. `StdError.stderr`, when present, contains the latest stderr tail,
captured from at most 64 KiB. Initialization failures and exits retain this
diagnostic context.
