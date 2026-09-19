# The local backend retired

The desktop app offers exactly the feature set the web app offers. It works
against plue (Smithers Cloud) and, without it, as a signed-out shell — but it
no longer runs anything on the reader's own machine beyond serving the SPA,
proxying to the seams, and keeping the chat turn journal.

Everything in `apps/app/src/bun` that implemented a capability the web does not
have is gone: build targets and their runs, the in-process language servers,
local terminals, local repositories, harness detection, the seatbelt sandbox,
and the detached session daemon. With them went the six `local.*` runtime capabilities, the
flows gated on them, and the UI surfaces those flows were the only door to.

## Why

Two feature sets meant two products. Every local-only door was a flow the web
catalog hid, a card the web could not render, a refusal the web had to word,
and a second implementation of something plue already does inside a workspace
VM. One feature set is one product.

## Where the old code is

The full local backend is readable at commit **`42b8abbc1cf6`**, and is gone as
of the deletion commit:

> **Before: `42b8abbc1cf6`** — the last state carrying the whole local backend.
> **After: `57a48653c7e8`** — this deletion.

Peer sessions landed on `main` between the two, so they are not parent and
child. Read the removed code with `jj file show -r 42b8abbc1cf6 <path>`, or
diff a single cluster with
`jj diff --from 42b8abbc1cf6 --to 57a48653c7e8 apps/app/src/bun`.

## What was removed and what replaced it on the web

| Cluster | Removed from `apps/app/src/bun` | Lines | What the web does instead |
| --- | --- | --- | --- |
| Target runs | `Targets.ts`, `TargetGraph.ts`, `TargetRunHistory.ts`, `Affected.ts`, `CiMatrix.ts`, `Node.ts`, `DeclarationBindings.ts`, `routes/repoTargets.ts`, `routes/targetGraph.ts` + tests | 5,987 + `Affected.ts`/`CiMatrix.ts` and their tests | Nothing. Targets were local-only; the web never had them. |
| Language servers | `lsp/` (`LspHost.ts`, `LspSession.ts`, `LanguageServers.ts`, `JsonRpc.ts`, `LspFixture.ts`), `routes/lsp.ts` + tests | 2,422 | plue's language server inside the workspace VM, relayed over the `/api/cloud-ws/repos/{o}/{r}/workspace/sessions/{id}/lsp` tunnel this origin already serves (`mainview/state/CloudLspClient.ts`). The `code.*` flows stayed; their door moved from `local.lsp` to `cloud.terminal`, the same tunnel the workspace terminal rides. |
| Local terminal | `Pty.ts`, `PtySpawn.ts`, `SessionMonitor.ts`, `routes/pty.ts` + tests | 2,173 | The workspace terminal relay into a plue VM (`/api/cloud-ws/repos/…/terminal`), which both hosts already tunnel. |
| Local repositories | `Repos.ts`, `RepoFiles.ts`, `LocalRepository.ts`, `RepositoryAuthority.ts`, `routes/tutorialRepository.ts`, `sanitizeRemoteUrl.ts` + tests | 1,283 | Cloud repositories as plue workspaces. A repository is a workspace, never a directory on this machine. |
| Harness detection | `Harnesses.ts`, `routes/harnesses.ts`, `routes/agents.ts` + tests | 230 | plue injects the credentials into the guest, so the app never probes for a CLI on the reader's box. |
| Sandbox | `Sandbox.ts` + test | 377 | Nothing to wrap. Two `Bun.spawn` calls survive: the keychain read in `CloudAuth.ts`, and the `git` reads in `routes/tutorial2-agent_change.ts`, a route no production host mounts (nothing supplies its `tutorialChangeHost`). Neither needs a seatbelt profile. |
| Session daemon | `LocalDaemon.ts`, `LocalDaemonProtocol.ts`, `LocalDaemonClient.ts`, `LocalDaemonLease.ts`, `LocalDaemonStop.ts` + test | 600 | Nothing. The daemon existed so long-running LOCAL work survived the window closing, and that work was targets, terminals and harnesses. Long-running work now lives in a plue workspace, which survives on its own. |

That is 13,072 lines of `apps/app/src/bun`, plus `Affected.ts`, `CiMatrix.ts`
and their three tests, whose line counts were not captured before they were
removed. Another ~5,000 lines of the renderer went with them: the target and
graph controllers, the target, graph, CI, affected, run-history and
run-timeline cards, the flows that were their only door, and the tests and
Playwright specs of all of it.

The daemon's one surviving job is single ownership of the chat turn journal's
SQLite file. `TurnJournalLease.ts` keeps exactly that: a pid file beside the
database, taken over when its owner is dead.

## One correction to the plan

Code intelligence was listed as local-only because the three `code.*` flows
declared `runtime: ["local.lsp"]`. That declaration was stale: the seam behind
them is dual-path and its cloud half is complete and wired
(`mainview/state/CloudLspClient.ts`, 815 lines, over the `/api/cloud-ws/…/lsp`
tunnel `apps/app/src/bun/server.ts` still serves). Deleting the flows would
have removed the only door to a working web feature, so they were kept and
re-doored on `cloud.terminal`. `CodeIntelSeam.ts`'s local branch and
`state/LspClient.ts` survive as unreachable code; see the follow-ups below.

## The capability rows that went

`packages/rpc/src/AppBootstrap.ts` no longer names `local.repositories`,
`local.repository-path-entry`, `local.targets`, `local.terminal`,
`local.harnesses` or `local.lsp`, and `localCapabilities` in
`packages/rpc/src/HostCapabilities.ts` emits only `agent`, `browser.read`,
`identity`, `cloud`, `cloud.terminal` and `cloud.pat` — the same rows the
Worker can emit. No host has a `local.*` door, so `registry.ts` `nativeOnly`
and `Commands.ts` `explainAbsent` have nothing left to refuse.

The native Electrobun RPC surface is down to one door, `openExternal`. The
folder picker (`pickLocalRepository`) is gone from
`packages/rpc/src/NativeRPC.ts`, from `mainview/native/NativeBridge.ts`, and
from the packaged E2E bridge.

`@smthrs/harness-detect` has lost its only consumer. The package is left in
place, unreferenced, for Will to decide on.

## Follow-ups this cut did not take

- `mainview/state/seams/CodeIntelSeam.ts` still branches on a local repository
  and calls `mainview/state/LspClient.ts` (`/api/lsp/*`). No local repository
  can exist any more, so the branch is unreachable; separating it from the
  cloud path is its own change.
- `mainview/state/controller/connectors.ts` `reduceAccess` still calls
  `/api/repos`, `/api/repo/access` and `/api/repo/close`. Its flows are gone,
  so nothing reaches it.
- `mainview/state/PtyClient.ts` and `tabs/TerminalView.tsx`'s local branch
  still speak `/api/pty*`. The cloud workspace terminal shares that view and
  still works.
- `packages/rpc` keeps the card schemas for the retired kinds (`targets`,
  `graph`, `target-run`, `run-timeline`, `run-history`, `affected`,
  `ci-matrix`, `repo`) so a conversation saved before the cut still decodes.
  `cards/CardRenderers.tsx` renders them as empty. Dropping the schemas is a
  persistence migration, not part of this change.
