# Native Smithers by injection

Status: approved by Will on 2026-10-20 at 23:27, with question 1 changed ([§8](#8-wills-answers-2026-10-20-2327), ruling ARCH-18): the app keeps a subset of the database plus an LRU cache on the device, so §3 is superseded and is rewritten before the native app is built. The `Api.ts` split is approved and not built. Merged by Claude Opus from two independent designs, Opus and Codex Sol (PROC-6). It answers Will's Telegram request at 20:12 on 2026-10-20: "support downloading a native bunfig app ... just dependency injection".

**Summary.** The native app is an Electrobun window around a Bun process that serves the same `apps/mvp` frontend, routes and flows as Cloudflare. Its own composition swaps in local Layers: Postgres and Electric, the Bun flow host, a Microsandbox machine over the local working copy, and a jj forge. It shares branches with the hosted app through the hosted git proxy, fenced by expected SHA.

**In one paragraph.** Most hosted services already sit behind tags: `Sandboxes`, `Machines`, `Rooms`, `TerminalSockets`, `FlowStarter`, `Forge`, `HostModel`, `ImmutableCache` and `SqlClient`. The machine logic (`worker/branch/Machine.ts`) already runs over any `Box`. `ImportRules` already confine Cloudflare to seven files (`apps/mvp/PACKAGE.ts:182`). Two seams are missing. First, `worker/ChatApi.ts` `program()` (lines 80-297) builds the Cloudflare services and the route table in one function. Second, repository reads take a concrete Code Storage client (`worker/RepoApi.ts:96`). Fix both, and the native app is a second host directory beside `worker/`, with no product fork. The native app is a complete local deployment with its own Postgres, because every route handler assumes one database holding branches, shares and conversations together. Sync with the hosted app is per branch: git objects through the hosted proxy, and later conversations as a union of immutable messages. Tables are never replicated.

## Architecture

```
┌──────────────── Smithers.app (Electrobun, macOS arm64) ────────────────┐
│ WKWebView  http://127.0.0.1:47474   (same dist/ as smithers.sh)         │
│   React + TanStack DB on OPFS + outbox (0002)                           │
│   browser engine: agent flows in a leader worker (0011)                 │
│        │ same-origin /api/*  (+ per-launch loopback token)              │
│        ▼                                                                │
│ Bun main process: apps/mvp/native/main.ts                               │
│   worker/Api.ts  (the one route table, shared with Cloudflare)          │
│   └─ NativeHost Layers                                                  │
│      SqlClient ─────────▶ Postgres 17 ─▶ Electric 1.8 (ShapeProxy)      │
│      FlowStarter ───────▶ BunRuntime engine on that Postgres            │
│      Sandboxes/Machines ▶ Microsandbox VM, working copy at /workspace   │
│      Forge, RepoSource ─▶ jj over the person's local repository         │
│      Rooms ─────────────▶ in-process room map                           │
│      model route ───────┐                                               │
│      branch/Publish ────┼─┐                                             │
└─────────────────────────┼─┼─────────────────────────────────────────────┘
                          │ │  device credential (Keychain)
                          ▼ ▼
┌──────────── hosted Smithers (Cloudflare, unchanged code) ──────────────┐
│ /api/model/<role> ─▶ ModelEndpoint ─▶ Qwen on Cerebras (ARCH-17)        │
│ /api/git/<o>/<r>.git ─▶ GitProxy.uploadPack (exists)                    │
│                      └▶ GitProxy.receivePack (new, SHA fence) ─▶ Code   │
│                                                              Storage    │
│ GitHub App, webhooks, secrets keys: stay here                           │
└─────────────────────────────────────────────────────────────────────────┘
```

## 1. The DI seams

Status: **exists** means the native Layer or behavior is already in the tree. **Small adapter** means the contract exists and the native implementation is under about 150 lines over existing code. **Missing** means new design or new package code. All paths are relative to the repository root.

| Service | Cloudflare impl | Native impl | Status | File |
|---|---|---|---|---|
| Route table | `program()` builds Hyperdrive, Durable Object handles, rate limits and the routes together | extract the routes to `worker/Api.ts`, which takes a host record of Layers; `ChatApi.ts` and the native host each supply one | missing (refactor) | `apps/mvp/worker/ChatApi.ts:80-297` |
| HTTP server, assets | Alchemy `Cloudflare.Worker`; site Worker sends `/api/*` to ChatApi and the rest to `ASSETS` | `NodeHttpServer` from `@effect/platform-node` 4.0.5 under Bun, serving `dist/` and `Api` on loopback | small adapter | `apps/mvp/worker/index.ts:8-11`, `apps/mvp/package.json:73`; prior art `apps/app/src/bun/server.ts` |
| Postgres `SqlClient` | `Database.layer` over a Hyperdrive connection string | the same layer over the local Postgres URL; same migrations | exists | `apps/mvp/db/Database.ts:68-69`, `apps/mvp/worker/ChatApi.ts:46-53` |
| Electric shapes | `ShapeProxy` to the Electric container | the same `ShapeProxy` to a local Electric | exists (code); packaging is slice 2 | `packages/effect-electric/src/ShapeProxy.ts`, `apps/mvp/infra/ElectricGateway.ts:29` |
| `FlowStarter`, `RoleChecks`, `TodoRuns` | `FlowExecution` Durable Object per execution over `CloudflareRuntime` | `BunRuntime` engine over the local Postgres, with the same registrations (`ExecutionHost.remote`, `with*`) | small adapter | `apps/mvp/worker/Flows.ts:21-29`, `apps/mvp/worker/Executions.ts:49-199`, `apps/mvp/worker/ExecutionHost.ts:49-157`, `packages/smithers/flows/platform-bun/src/BunRuntime.ts`; proof pattern `apps/mvp/worker/test/flowHost.ts` |
| `Sandboxes`, `Machines` | `SandboxObject` Durable Object and `ContainerSession` | a `Box` over `MicrosandboxSandbox`, a Linux guest so `Machine.ts`'s per-person users and `/workspace` hold; `Store` rows in Postgres | small adapter | `apps/mvp/worker/branch/Sandboxes.ts:49-64`, `apps/mvp/worker/branch/Machines.ts:31-56`, `apps/mvp/worker/branch/Machine.ts:30`, `apps/mvp/worker/BranchSandboxes.ts:433-537`, `packages/smithers/flows/sandbox/src/MicrosandboxSandbox` |
| `TerminalSockets` | `terminalSocketsOver` and `ContainerTerminal` | Bun WebSocket to a pty session in the guest | small adapter | `apps/mvp/worker/branch/Sandboxes.ts:67-91`, `apps/mvp/worker/BranchSandboxes.ts:457` |
| `Rooms` | `RoomObject` Durable Object with hibernating sockets | one in-process room map; one process holds every socket | small adapter | `apps/mvp/worker/branch/Rooms.ts:23-37`, `apps/mvp/worker/BranchRooms.ts:34-145` |
| `Forge` | `Forge.codeStorage`, `Forge.gitHub`; `branchHead` and `defaultBranch` call `GitRemote` over HTTP | `Forge.local` over `Jj`; the contract gains `head` and `defaultBranch`, so no caller hands a `file:` path to HTTP helpers | small adapter, with a contract extension | `apps/mvp/worker/branch/Forge.ts:33-40, 86, 95`, `packages/smithers/flows/jj/src/Jj.ts:389`, `packages/smithers/flows/jj/src/bun/BunJj.ts` |
| Repository reads (tree, blob, commits) | `RepoReads` over `Option<CodeStorage.Client>` | a `RepoSource` tag with a Code Storage Layer and a jj Layer | missing (seam) | `apps/mvp/worker/RepoApi.ts:96, 110-111` |
| `CodeStorage` client | `RepoConfig.codeStorage` with the organization key | not provided: the device never holds the organization key (0011 §2) | exists (absent by design) | `packages/effect-code-storage/src/CodeStorage.ts:916`, `apps/mvp/worker/RepoConfig.ts:23-40` |
| `ImmutableCache` | `EdgeCache.layer` (Cache API) | a bounded file cache under Application Support; the same SSRF checks on page previews | small adapter | `packages/smithers/flows/artifacts/src/ImmutableCache.ts:151`, `packages/smithers/flows/platform-cloudflare/src/EdgeCache.ts:67` |
| Throttle | `Cloudflare.RateLimit` limiters; key from `cf-connecting-ip` | always-allow limiters; the server ignores forwarding headers | exists | `apps/mvp/worker/Throttle.ts:67, 79`, `apps/mvp/worker/ChatApi.ts:160-167` |
| Model endpoint | `HostModel.layerConfig("CHAT_MODEL")` behind `/api/model/<role>`, budget and sign-in checks | forward `/api/model/<role>` to the hosted endpoint with the device credential; hosted spend checks apply once | small adapter | `apps/mvp/worker/ModelEndpoint.ts`, `packages/smithers/agent/model/src/ModelProxy.ts`, `packages/smithers/agent/model-host/src/HostModel.ts:75` |
| `Sessions`, `CurrentActor` | GitHub OAuth through the App; `SESSION_SECRET` | hosted sign-in in the system browser, a one-use callback exchange, a device credential in the Keychain; the local server admits only its own window | missing (device sign-in) | `apps/mvp/worker/Actor.ts:75-86`, `apps/mvp/worker/SignIn.ts:572` |
| GitHub App | `Option<GitHubApp>` from config; webhooks; installation tokens | `None`: the existing routes refuse; GitHub stays a hosted feature | exists | `apps/mvp/worker/github/Config.ts:54-70` |
| Secrets egress | `Vault`, `Audit` and Cloudflare outbound handlers | off (`SANDBOX_SECRETS` defaults off); later a loopback egress proxy as the guest's only route out, and a Keychain sealing key | missing (deferred) | `packages/smithers/flows/secrets/src/Egress.ts:203, 240`, `apps/mvp/worker/secrets/SandboxEgress.ts`, `apps/mvp/worker/BranchSandboxes.ts:58` |
| Logs, traces | `Cloudflare.Telemetry`, structured JSON logs | the same logger to a file, OTLP to the hosted relay | exists | `apps/mvp/worker/ChatApi.ts:154, 287` |
| Alert channels | `channelsConfig` | none configured | exists (off) | `apps/mvp/worker/AlertChannels.ts`, `packages/smithers/notifications/src/Channels.ts:280` |
| Browser engine | leader worker, wa-sqlite on OPFS | the same, in WKWebView; slice 1 runs 0011's kill-and-resume test there first | exists (to prove in WKWebView) | `packages/smithers/flows/platform-browser/src/BrowserRuntime.ts`, `apps/mvp/src/flows/engine.worker.ts` |
| Branch sync | none | `branch/Publish` and `branch/Fetch` flows on the native host; `GitProxy.receivePack` with a SHA fence on the hosted side | missing | `packages/effect-code-storage/src/GitProxy.ts` (only `uploadPack` today) |

**Count: 21 seams. 8 exist, 8 need a small adapter, 5 are missing** (the route-table refactor, repository reads, device sign-in, branch sync and, deferred, secrets egress).

## 2. Packaging: Electrobun

| | Electrobun | `bun build --compile` + system webview |
|---|---|---|
| Window, dock icon, menus | yes | no; Bun ships no native window, so it opens the default browser at a localhost URL |
| Bun main process | yes | yes |
| Updates | built-in updater with bsdiff patches from static files | none; we write one |
| Signing, notarization | configured in `electrobun.config.ts` | manual `codesign` and `notarytool` over a bare binary and every helper |
| Prior art here | `apps/app` shipped `Smithers.app` (`apps/app/build/stable-macos-arm64`, 159 MB) from `apps/app/scripts/build-native.ts`, which bundles Postgres (`:135-148`), jj, git and Microsandbox | `packages/smithers/scripts/build-tui-binaries.mjs`, CLI only |
| Recorded decision | 0010 and SCOPE-10 name it | none |

**We pick Electrobun.** The main process is a plain Bun entry, so `apps/mvp/native/main.ts` also runs headless for tests and on the Mac mini.

- **Origin.** The window loads `http://127.0.0.1:47474`, served by the Bun process. A fixed loopback origin is a secure context, keeps OPFS and the service worker stable across launches, and keeps `/api/*` same-origin, so the frontend needs no change. The process takes a single-instance lock, binds loopback only, checks `Origin` and `Host`, and requires a per-launch token on every request and socket upgrade. A port held by another process fails closed.
- **Webview.** We stay on WKWebView if OPFS sync access handles, dedicated workers, Web Locks, IndexedDB, streaming, framed views and the terminal pass. We bundle CEF only on a named failure.
- **No bridge in product code.** The frontend never calls Electrobun. Native capabilities are routes and flows the native host provides.
- **Updates.** The updater reads static artifacts from our hosted storage, with stable and canary channels as configuration. Before restart, local flows checkpoint and pause; they resume on reopen (0011). Local Postgres runs `apps/mvp/db/migrations` at boot and records a migration receipt; an older binary refuses a newer database rather than rolling back over it. Device stores migrate per 0021, unchanged. The update step checks the code signature, not only a hash, before it runs a replacement.
- **Signing.** Developer ID Application, hardened runtime, notarized and stapled. Every nested helper is signed; Microsandbox's helper gets `com.apple.security.hypervisor`. Signing keys live in private infrastructure configuration. A Smithers release flow builds on a macOS host, not GitHub Actions (rulings, no-Actions rule).
- **Platforms.** macOS on Apple silicon first: Microsandbox runs on Apple's Hypervisor framework. The minimum macOS version comes from testing the pinned Electrobun and Microsandbox releases. Linux follows; Intel Macs and Windows are not planned.

## 3. Local–remote sync

**Rule: each row has one home deployment; branches are shared through git.** The native app is a complete local deployment and never replicates hosted tables. The hosted backend is the sync peer: it holds the credentials, proxies the git transport, and rechecks access on every transfer. Will's "using that same backend as the proxy" maps onto this proxy and onto the forwarded model route.

```
native                                       hosted
jj working copy ─ git push ──▶ /api/git/<o>/<r>.git ─▶ GitProxy.receivePack ─▶ Code Storage
                               device credential       fence: old SHA = recorded head
jj working copy ◀ git fetch ── /api/git/<o>/<r>.git ◀─ GitProxy.uploadPack (exists)
branches row ◀──────────── same branch id ──────────▶ branches row (branch/Track)
```

- **Push.** `branch/Publish` is a durable flow keyed by a sync operation id and the exact source commit. It pushes one ref through the hosted proxy. `GitProxy.receivePack` reads the pkt-line command `old new ref` and refuses the push when the ref isn't the one branch the credential names, when `old` differs from the hosted row's recorded head, or when the ref is `main` or protected (0012 §7). Git applies the objects and the ref update in one request. After an unknown outcome the flow reads the remote head before it pushes again. The device never holds a Code Storage token.
- **Fetch.** `branch/Fetch` reads through the existing `uploadPack`. A clean checkout fast-forwards; a dirty one fetches into a tracking ref and keeps the person's files.
- **Identity.** On first publish the hosted app tracks the branch and returns its id, and the local row takes that id. The conversation id is `uuidv5(branch id)` (0013 §2), so it matches on both sides.
- **Conflicts (0002, 0012 §7).** Fast-forward only, never force. A divergent head keeps both commits, parks the publish, and shows Needs you with both SHAs. The person, or the agent in the local machine, merges in the working copy and publishes again. Uncommitted files never sync; only a commit or checkpoint does. Deleting a branch is an explicit tombstone, never inferred from a missing ref.
- **Conversations (slice 3).** Messages are immutable rows with client-chosen ids (0002), so a conversation syncs as a set union: the same id with the same content is a no-op, and the same id with other content is 0002's 409, shown as Not sent.
- **Not synced:** sessions, grants, stack counters, model charges, terminals, process state, VM state and engine journals. A run belongs to the host that started it (0011).
- **Secrets never leave their side.** Sync carries git objects and, later, messages. The model key, the GitHub App key, `SECRETS_KEY` and Code Storage tokens stay hosted. Local secret values are sealed under a Keychain key and never sync. Logs and counters record operation ids, outcomes, bytes and refusal classes, never paths, content or credentials.
- **No sync daemon.** Reconnecting starts or resumes the registered sync flows; the engine owns retries.

## 4. The files that differ

`ImportRules` already name the Cloudflare host files: `ChatApi`, `DevChatApi`, `index`, `Executions`, `ExecutionHost`, `BranchSandboxes` and `BranchRooms` (`apps/mvp/PACKAGE.ts:182`), plus `alchemy.run.ts` and `infra/`. The native host mirrors them in one directory.

| File | Change |
|---|---|
| `apps/mvp/worker/Api.ts` | new, shared: the route table moved out of `ChatApi.program()`, taking a host record of Layers |
| `apps/mvp/worker/ChatApi.ts` | shrinks to the Cloudflare host record |
| `apps/mvp/worker/RepoApi.ts` | takes a `RepoSource` instead of `Option<CodeStorage.Client>` |
| `apps/mvp/worker/branch/Forge.ts` | the contract gains `head` and `defaultBranch` |
| `apps/mvp/native/main.ts` | Electrobun main: start Postgres and Electric, migrate, serve `Api` on loopback, open the window |
| `apps/mvp/native/Host.ts` | the native host record: every adapter in §1 that implements an `@smthrs/mvp/*` tag |
| `apps/mvp/native/electrobun.config.ts`, `native/build.ts` | packaging, ported from `apps/app/scripts/build-native.ts` |
| `packages/effect-code-storage/src/GitProxy.ts` | `receivePack` with the SHA fence |
| `packages/smithers/flows/platform-bun/src/` | generic host code only, such as reading a local jj repository; app tags stay in the app |

**Deletion test.**
- Delete `apps/mvp/native/`: the hosted app builds and every test passes.
- Delete `ChatApi.ts`: `Api.ts` still type-checks with any host record.
- Run the same flow tests (`sandbox/Call`, `branch/Publish`) against the Cloudflare and native Layers; both pass.
- `ImportRules` forbid `electrobun`, `@smthrs/platform-bun` and `apps/mvp/native/**` in `src/**` and `worker/**`, and a Jev rubric refuses host checks such as `isNative` or `window.__electrobun`. The old app branched on `window.__electrobun` (`apps/app/docs/web-mode/PLAN.md:20`); this rule keeps that fork out.
- A second repository browser, TODO writer, agent loop or merge policy fails the test.

## 5. Slice 1: the walking skeleton

The native app opens a local repository, runs a flow in a local sandbox, and syncs one branch with the hosted app.

1. **Extract `worker/Api.ts`.** ChatApi's tests and the e2e suite stay green. This step alone also closes the ARCH-7 gap inside `program()`.
2. **Native host, dev window.** Electrobun dev build; the Bun process composes `Api` over the compose Postgres and Electric (`apps/mvp/docker-compose.yml`). Bundling them is slice 2. Run 0011's kill-and-resume test in WKWebView first.
3. **Open a local repository.** `main.ts --repo <path>` with a GitHub `origin`. The path is canonicalized, symlink escapes are refused, and nothing outside the repository is mounted. `Forge.local` tracks the current branch; the repository view reads through the jj `RepoSource`.
4. **Run a flow in a local sandbox.** `POST /api/sandbox/calls` starts `sandbox/Call` on the Bun host; `Machines` runs `git status`, then writes one file, in a Microsandbox guest over the working copy. Kill the process after the tool completes: on reopen the call is not run again.
5. **Sync one branch.** Sign in through hosted, then `branch/Publish` pushes the branch through `receivePack`; the hosted app shows the same SHA. Commit on the hosted side, `branch/Fetch` brings it back. A push from a stale head is refused.

**Proof:** one Playwright test against the native origin and one Bun test of the fence, against a real jj repository, a real microVM and the staging hosted app. No mocks. Model calls are not needed to prove these boundaries.

## 6. Where the plans disagreed

| Point | Opus | Sol | Final | Why |
|---|---|---|---|---|
| Local app database | bundled Postgres and Electric; the native app is a full deployment | slice 1 keeps metadata on hosted; later PGlite plus a local changefeed adapter | Opus | `sandbox/Call` settles in Postgres and its route checks `branchAccess` over branches, shares and conversations (`worker/branch/SandboxCalls.ts`). A local flow can't settle into hosted Postgres without a new path. Real Postgres runs the same migrations and `FOR UPDATE` (`worker/stack/Stack.ts:131, 310`) with no SQL fork. Sol rightly rejects SQLite and multi-master; Electric can't read PGlite, so PGlite needs new changefeed code. |
| Repository reads | missed | `RepoApi` takes a concrete Code Storage client | Sol | Verified at `worker/RepoApi.ts:96`. Added as a missing seam. |
| `Forge` contract | adapter only | needs `head` and `defaultBranch` | Sol | Verified: `branchHead` and `defaultBranch` call `GitRemote` over HTTP (`worker/branch/Forge.ts:86, 95`). |
| Local sign-in | `DevChatApi`'s fallback actor | hosted sign-in with a one-use callback; fallback is not production auth | Sol | Any local process can reach a loopback port. The fallback stays for development only. |
| Loopback security | fixed port only | single-instance lock, `Origin`/`Host` checks, authenticated upgrades | Sol | Same reason. |
| Branch transport | `GitProxy.receivePack` with a pkt-line SHA fence | an authorized object transfer, then a CAS ref publish | Opus, with Sol's receipts | A receive-pack carries objects and ref update in one request, and the old SHA in its command is the fence 0005 §4 requires. Sol's operation id, read-before-retry, dirty-checkout and tombstone rules stay. |
| Where host code lives | `apps/native` | `apps/mvp/native` plus platform-bun adapters | Sol's directory; app tags in the app | `apps/mvp/native` imports `worker/Api.ts` without a cross-package deep import. Adapters for `@smthrs/mvp/*` tags must live in the app; only generic host code moves to platform-bun (SDK-4). |
| Shared route file name | `worker/Api.ts` | `worker/AppHost.ts` | Opus | "Host" already means the injected platform (SDK-4); this file is the route table. |
| Opening a repository in slice 1 | `--repo` flag | a plugin action | Opus for slice 1 | 0017's plugin slices are not built. The picker becomes a compiled plugin when they are. |
| Packaging, sandbox, model route | Electrobun, Microsandbox, hosted model proxy | the same | agreed | |

## 7. Questions for Will

1. **The native app keeps its own database and shares with the hosted app per branch, through git, not table by table. OK?** Recommendation: yes. It needs no SQL fork and no multi-master merge, and the hosted app stays the one writer of its rows.
2. **Must the native app work without a Smithers account, or with the person's own model key?** Recommendation: no. Sign in through the hosted app once, and send model calls through the hosted proxy (ARCH-17, 0011 §3). Bring-your-own-key comes later as a Layer.
3. **When do we build it?** SCOPE-8 defers the Mac install until after ship. Recommendation: build slice 1 step 1, the `Api.ts` extraction, now, because it closes an ARCH-7 gap on its own; build the rest after hosted ship unless local repositories are the next feature you want.

## 8. Will's answers (2026-10-20 23:27)

Status: approved, with question 1 changed (ruling ARCH-18).

1. **Data and sync.** Will: "The app is local first we keep a subset of the database always plus a LRU for other data on the frontend". The native app does not keep its own database shared one branch at a time through git. It syncs the same way the web app does: an always-kept subset plus an LRU cache, synced with the hosted backend (decision 0002; the LRU cap is `work/lru-size-limit.md`). Git branches still sync through the hosted git proxy for code. Section 3 is superseded where it says otherwise and will be rewritten when the native app is built.
2. **The `Api.ts` split.** Will: "Yes". Move ChatApi's routes into `worker/Api.ts` now, so that Cloudflare and the native app each supply only their own services (ARCH-7). This happens after tonight's deploy (burn-down).
