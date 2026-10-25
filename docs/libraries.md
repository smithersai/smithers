# Smithers libraries

Smithers ships a library for most jobs an agent or a maintainer codes by hand.
Before you write code that calls a model, runs an agent loop, makes a durable
workflow, renders UI, or touches GitHub, find the job below and use that
library. Hand-rolling one needs a stated reason in the change, such as a
missing feature and the issue that tracks it.

**Everything is a durable flow** ([AGENTS.md](../AGENTS.md)):
- Every action, including every model call, runs as an `@smthrs/flow` step on
  the user's machine, on Cloudflare, or on the sandbox provider.
- Retries, resumption and idempotency come from the engine, never from app code.
- Never use Cloudflare Workflows, `waitUntil` jobs, Temporal, Inngest, the
  Vercel AI SDK or LangChain in place of it. A missing host is SDK work.

Paths are relative to the repository root. A package is published to npm under
the `next` tag unless it is marked *private*. Every library takes `effect`
4.0.5 as a peer dependency. Each package's `README.md` and `docs/` hold the
full API; the name in each table links to the best starting page.

## Which library for which job

| Job | Library | Call |
| --- | --- | --- |
| Strip TypeScript types and lower imports before isolated QuickJS evaluation in a Worker | `sucrase` | `transform(source, { transforms: ["typescript", "imports"], production: true })`; pure JavaScript, no native process or runtime WASM compilation. The catalog previously had no library for this job; browser language services answer editor queries, not this transform. The app wraps transformation errors in its Effect-based realm. |
| Call a model: streaming, any provider, OpenAI-compatible APIs | `@smthrs/model` | `Route.openaiChatCompatible`, `Route.anthropic`, `Route.layer`, then `Model.Model` and `model.stream(request)` |
| Pick a host's model from configuration, with keys kept on their origin | `@smthrs/model-host` | `HostModel.layerConfig("CHAT_MODEL", fallback)`, then `yield* HostModel` for `model` and the credential-free `route.prepare`; `HostModel.make(record)` for a record read at run time, such as an admin's database row |
| Serve a model over HTTP so a browser calls it without the key, and meter it | `@smthrs/model` | `ModelProxy.serve({ prepare, attributes, onEnd })` on the host; `ModelProxy.layerClient({ url })` as the browser's `Model` |
| Make one model call a durable flow step: replayed after a crash, retried on capacity errors, never paid for twice | `@smthrs/agent` | `ModelStep.run({ name, request, model: host.model, route: host.route })` inside a flow, with `HostModel` from `@smthrs/model-host` |
| Decide inside a flow: classify, filter, rank, yes or no over items | `@smthrs/model` | `Classifier.make` with the host `Evaluator`, one request with one question per item, never a model seat. A judge on a model route (`Evaluator.layerFromSeat`) takes `ModelStep.model` from `@smthrs/agent`, so each reading is a sealed step |
| Run an agent loop with tools | `@smthrs/agent` | `AgentAction.make` for one typed step; `AgentSession.layer` for a run an operator can steer and approve |
| Declare a feature as a plugin manifest (views, slots, commands, keybindings) and load a set of them without running plugin code | `@smthrs/plugin` | `Manifest.decode(json)`, then `Load.load(hostFacts, candidates)` for `{ contributions, refused }`; the UI goes through `PluginHost` |
| Give an agent standard tools: read, edit, grep, bash, tests, fetch, web search | `@smthrs/std` | `Manifest.flows`, `Manifest.handlers`, `Read.run`, `Bash.run` |
| Give an agent a language server for `lsp` and for the errors an edit leaves | `@smthrs/platform-node` | `NodeLanguageServer.layer({ command, args, cwd })` binds `@smthrs/std`'s `LanguageServer` |
| Answer hovers, definitions, references, an outline and diagnostics for TypeScript and JavaScript in a browser tab, over a repository at a commit, with no machine | `@smthrs/platform-browser` | `BrowserLanguageServer.make({ worker, workspace: { paths, read } })` in the tab binds `@smthrs/std`'s `LanguageServer`; `BrowserLanguageServer.serve({ typescript, lib })` in the worker module |
| Give an agent an MCP server's tools | `@smthrs/mcp` | `McpFlows.connected(...)`, then `.bindings()` |
| Make a durable workflow | `@smthrs/flow` | `Flow.make("<tag>", {...})` and `Action.make` at `.smithers/flows/<name>/flow.ts` |
| Retry, sleep durably, wait for a person or a webhook | `@smthrs/flow` | `RetryPolicy.make`, `DurableClock.sleep`, `HumanTask`, `WaitFor`, `Poll.make` |
| Narrow a capability ceiling a credential or message carries, hop by hop | `@smthrs/flow` | `Flow.intersectCeilings(caller, callee)`, and `Flow.ceilingWithin(callee, caller)` to refuse a wider callee |
| Run a review loop, bounded fan-out, saga or escalation | `@smthrs/patterns` | `ReviewLoop.run`, `Bounded.all`, `Saga.run` |
| Run flows in a Node or Bun program | `@smthrs/platform-node`, `@smthrs/platform-bun` | `NodeRuntime.layerHost` from `@smthrs/platform-node` or `BunRuntime.layerHost` from `@smthrs/platform-bun`; tests use `TestNodeRuntime.durableEngine` or `FlowEngine.layerMemory` from `@smthrs/engine` |
| Run flows in a Cloudflare Worker, one Durable Object per execution | `@smthrs/platform-cloudflare` | `ExecutionObject.start` and `ExecutionObject.alarm` in the object, with `CloudflareRuntime.layer({ hostId, executionId }, registration)` |
| Run flows in a browser tab, durably: one leader worker per origin, SQLite on OPFS | `@smthrs/platform-browser` | `BrowserRuntime.run({ name, sqlite: { module, wasm }, flows, registerFlows })` in the engine worker, with lazy imports of the wa-sqlite build, and `authorize` for a check on the app's database before each activation builds the engine; `BrowserEngine.layer({ name, worker })` in each tab, then `start`, `result`, `cancel`, `signal` |
| Keep a browser app's own data in SQLite on OPFS, shared by every tab, on the engine's one SQLite build | `@smthrs/platform-browser` | `SharedSqlite.open({ name })` as TanStack DB's browser persistence `database`; `SharedSqlite.layer({ name })` for `execute` in Effect |
| Run this repository's chores: land, claim an issue, sync docs, cut a release | `.smithers/flows` | `pnpm exec smthrs flow start <name> --data '<json>' --wait` |
| Touch GitHub from product code: API calls, comments, labels, webhooks | `@smthrs/integrations` | `GitHub.GitHubClient.layer` with `FetchHttpClient.layer` from `effect/http`, `GitHub.Actions.CommentOnIssue`, `Core.Channel.make`; issues, comments and labels with `GitHub.Issues` (`getIssue`, `createComment`, `addLabels`, `removeLabel`, `createLabel`), a file's text with `GitHub.Contents.getText`, an account's access with `GitHub.Collaborators.permission`, a check's state on a commit with `GitHub.Statuses.create` |
| Comment on, label or close an issue in this repository | `issue-claim` flow | `pnpm issue-claim claim\|comment\|release <repo>#<n> --by <agent/session>` |
| Render UI: buttons, pills, KPI tiles, chat, diffs, Markdown, outside web pages, themes | `@smthrs/ui` | `SmithersUiStyles` once at the root, then `Button`, `StatusPill`, `KpiStat`, `EmptyState`, `ChatTranscript`, `ChatComposer`, `DiffHunks`, `Markdown`, `WebPageView`, `WebLinkCard` |
| Show that something is loading | `@smthrs/ui` | `LoadingBar` (a thin bar at the top, or along a busy card's edge) or `Skeleton` in the content's place; both stay hidden for `LOADING_DELAY_MS` (300). There is no spinner |
| Show UI a model writes: check a TSX view, render it to HTML in a QuickJS realm, show it in a sandboxed frame, take its declared events | `@smthrs/views`, `@smthrs/ui` | `ViewCode.check`, `PresentationRealm.layer({ bundle })` with `loadPresentationBundle()` from `@smthrs/ui`, then `realm.render` and `realm.interact`; `<GeneratedView html interactions onInteraction />`; templates `FlowFormView` and `IssuesView` |
| List issues, pull requests or TODOs, and show one, as GitHub does: state icons, Open and Closed tabs, a row's menu, a timeline and a side column | `@smthrs/ui` | `<IssuesView issues filter numberPrefix ordered />` with each row's `status`, `links` and `menu`; `<ItemConversation status events aside />` with `ItemAsideSection`; `ActionMenu`, `ConfirmButton` |
| Show a repository's home: read the sections `.smithers/home.json` declares, keep the ones a viewer may see, and draw them as data, live blocks included | `@smthrs/views`, `@smthrs/ui` | `Home.read(text)`, `Home.visible(sections, Home.widen(audience, contributors))`, then `<RepositoryHome sections files askHref onAsk offered live onNavigate onRun running />` |
| Show an outside web page: ask from a server whether it frames, then show it in a sandboxed frame or as a card with its title, description and icon | `@smthrs/views`, `@smthrs/ui` | `WebPage.check(url, { ancestors })` with Effect `HttpClient` on the server; `<WebPageView url preview />` when `allowed`, else `<WebLinkCard url title description icon />` |
| Show a repository: its file tree, a directory with its README, a highlighted file or patch, or a Markdown document read or edited in place | `@smthrs/repo-view` | `<RepoView name tree location file readme href onNavigate />`; `CodeFileView`, `PierreDiffView`, `MarkdownEditor`; load the module that renders one lazily |
| Show a language server's help on code as GitHub does: symbol highlights, problems in the gutter, a hover card, a keyboard cursor, and a Symbols pane with definitions, references and the outline | `@smthrs/repo-view` | `CodeFileView`'s `marks`, `hover`, `cursor`, `onCursorMove`, `onTokenSelect` (or `RepoView`'s `code`); `<SymbolsPane symbol outline href onOpen onClose />` in `RepoView`'s `aside` |
| Edit a file's text with others at once, with their carets | `@smthrs/repo-view` | `CodeEditor` (CodeMirror) with `collaborators`; `LiveMarkdownEditor` for Markdown; both report each edit with its `base` |
| Show a live shell in a page: xterm.js in a sandboxed frame, with a reconnecting socket to the terminal host | `@smthrs/terminal-frame`, `@smthrs/platform-browser` | `<TerminalFrame title theme readOnly stream onInput onResize onKey />`; `TerminalSocket.connect(url, { onOutput })` with `TerminalSocket.layerWebSocket`, then `send`, `resize` and `status`; the wire is `TerminalProtocol` from `@smthrs/sandbox` |
| Keep app state in TanStack DB collections and live queries, through Effect | `@smthrs/effect-tanstack-db` | `Collection.local({ id, schema, getKey })`, `LiveQuery.make((q) => ...)` with `Query.eq` and the other expressions; read `rows` and `changes` streams, write with `insert`, `update`, `delete` |
| Carry a device's stored collections and queued writes across deploys | `@smthrs/effect-tanstack-db` | `Migrations.local` / `synced` / `payload` / `registry`; `Migrations.prepare(registry)` for `@smthrs/platform-browser`'s `BrowserRuntime.run({ prepare })`; `Outbox.layer({ upgrade: Migrations.outbox(registry) })`; `Migrations.check` against a committed lock |
| Sync Postgres rows into a collection through Electric, and proxy its shapes from your server | `@smthrs/effect-electric` | `ElectricCollection.make({ id, schema, getKey, shape, syncMode, retry, onInsert })`, then `sync`, `reconnect`, `awaitTxId`; `ShapeProxy.make({ ...connection, shape: { table } })` on the server |
| Import a public GitHub repository into git hosting and read its files and commits | `@smthrs/effect-code-storage` | `CodeStorage.layerConfig` (or `CodeStorage.layer(credentials)`), then `createRepo`, `pullUpstream`, `listFiles`, `readFile`, `listCommits`; `GitRemote.head` for a remote's default branch with no credential |
| Make a branch on git hosting at another ref's commit, with no clone or push | `@smthrs/effect-code-storage` | `CodeStorage.Client.createBranch(repo, { branch, from })` |
| Share a route, schema or card contract between the app, the Worker and the TUI | `@smthrs/rpc` | `import { Cards, ConfiguredModel } from "@smthrs/rpc"`: every module is a namespace on the root |
| Spawn a process or touch the filesystem | `@smthrs/platform-node`, `-bun`, `-browser` | Provide `NodeHost.layer`, `BunHost.layer` or `BrowserHost.layer`; library code asks for Effect's `FileSystem` and `ChildProcessSpawner` |
| Gate every file, process and network effect behind allow, deny or ask | `@smthrs/kernel` | `HostServices.layer`, `GrantStore.layer`, `Workspace.layer` |
| Run commands on a container, microVM, Kubernetes Pod or cloud sandbox | `@smthrs/sandbox` | `Sandbox.layerHost(provider, ...)`, `ContainerSandbox.make`, `CloudflareSandbox.make` |
| Give an agent, a button or an API typed tools on a machine's working copy: run a command at most once, read, write and list files, git status and diff; carry the working copy to the next machine | `@smthrs/sandbox`, with `@smthrs/platform-cloudflare` on Cloudflare | `SandboxTools.execute(session, call, { callId, callsDirectory })`, `SandboxTools.checkpoint`, `SandboxTools.restore`; a container Durable Object's session is `ContainerSession.make(container, { id, workdir, user })` |
| Read, snapshot or diff a jj working copy | `@smthrs/jj` | the `Jj` service; adapters `NodeJj.layerAt`, `BrowserJj.layer` |
| Write SQL with transactions, lock retries and migrations | `@smthrs/database` | `DurableWriter.layer`, `Migrations.layer`, plus one driver layer |
| Store large blobs by content hash | `@smthrs/artifacts` | `ArtifactStore.layerFileSystem`, `ArtifactStore.layerMemory`, `RemoteArtifacts.layer` |
| Cache content that never changes at its key, such as a file at a commit SHA: at Cloudflare's edge, in the browser or in memory | `@smthrs/artifacts`, with `@smthrs/platform-cloudflare` or `@smthrs/platform-browser` | `ImmutableCache.readThrough(ImmutableCache.key(namespace, ...parts), compute)`, provided by `EdgeCache.layer({ name })` in a Worker, `BrowserCache.layer()` in a browser, or `ImmutableCache.layerMemory()` in Node and tests |
| Remember and recall facts, notes and message history | `@smthrs/memory` | `Flows.runRemember`, `Flows.runRecall`, `MemoryStore.layer` |
| Start flows on a cron schedule or a verified webhook | `@smthrs/triggers` | `Trigger.make`, `Scheduler.layer`, `Webhook.make` |
| Start, approve, steer, cancel or watch runs from code | `@smthrs/control` | `Control.Control` with `ControlLive.layer` in process, or `ControlClient.layer({ url, credential })` |
| Follow a run's events live in a browser | `@smthrs/sync` | `SyncClient.layer`, `SyncServer.layer` |
| Show who is on a page, and where, live (presence) | `@smthrs/sync` | `PresenceRoom.join`, `receive`, `leave`, `evict` on the host, such as a hibernating Durable Object; `PresenceSocket.connect(url)` in the page |
| Edit one text together, live: a shared prompt, a file, an answer box (a CRDT) | `@smthrs/sync` | `SharedText.make`, then `replace(next, { caret, base })` or `edit` for this person's edits and `apply` for everyone else's; `anchor` and `resolve` for carets; `seed` and `validate` on the server |
| Draw other people's carets over a text field | `@smthrs/ui` | `CollaboratorCarets`, `useSharedSelection`; `ChatComposer` and `NeedsYouCard` take `collaborators` |
| Queue notifications or send coalesced alerts | `@smthrs/notifications` | `NotificationQueue.layer`, `Alerts.layerWebhook` |
| Send a person a short message by email or Telegram from a durable step, each failure classified for the engine's retry | `@smthrs/notifications` | `Channels.layer({ email: { apiKey, from }, telegram: { token } })`, then `(yield* Channels.Channels).send(destination, message)`; retry `DeliveryFailed`, record `DeliveryRefused` |
| Route a run or an event to the people who follow it, and merge their Read, Dismiss and Hide across devices | `@smthrs/notifications` | `Inbox.route`, `Inbox.audience`, `Inbox.raises`, `Inbox.ack`, `Inbox.isOpen`; `@smthrs/ui`'s `ToastStack` (`more`), `Toast`, `workNoticeVisible` to show them |
| Send logs, metrics and traces to OpenTelemetry | `@smthrs/observability` | `Otlp.layerFetch`, `Logger.layerStructuredJson`, `JournalLogger.layerJournalForwarding` |
| Count which flows run and how: runs by flow, outcome, door, actor and placement, durations, steps, retries, waits and model tokens | `@smthrs/flow`, recorded by the durable engine | Nothing to call: the engine records `RunMetrics` for every run. Name a run's door and actor with `RunMetrics.withOrigin({ door, actor })` where you start it; a host whose logs are its telemetry provides `RunMetrics.layerInfoLines` |
| Receive a browser's OTLP telemetry in your own Worker and log it | `@smthrs/observability` | `OtlpRelay.serve({ allow: { records, fields } })` under `/api/telemetry` |
| Let a sandbox or a flow step use a secret it never holds: a placeholder swapped for the value in request headers only for the secret's own hosts and methods, no redirects followed, decisions audited by name, echoes scrubbed from answers | `@smthrs/secrets` | `Placeholder.minter(key)` then `derive(scope, name)`; `Egress.forward(request, policy)` for an intercepted request or `Egress.execute(request, policy)` in a step, with the host's `HttpClient`, `Egress.Vault` and `Egress.Audit`; `Binding.Binding` and `Binding.checkValue` before storing |
| Hash, canonicalize JSON or derive a stable key | `@smthrs/crypto`, `@smthrs/canonical`, `@smthrs/keys` | `digest`, `canonicalize`, `deriveKey` |
| Provide Effect's `Crypto` over WebCrypto in any host | `@smthrs/crypto` | `WebCrypto.layer`, or `WebCrypto.make()` for the service value |
| Test a flow without a live model | `@smthrs/testing` | `ScriptedModel.make`, `CachedModel.make`, `TestHost.layer`, `PlanAssertions`, `JournalAssertions` |
| Run an eval suite against a committed baseline | `@smthrs/evals`, `@smthrs/scorers` | `Suite.make`, `Runner.run`, `Regression.compare`, `Gate.check`; `Scorer.make`, `Rubric.make` |
| Persist cloneable evaluation inputs without JSON coercion | `@smthrs/evals` | `Suite.encodeData` / `Suite.decodeData`, Effect wrappers over pinned devalue 5.9.2; preserve the versioned decoder when upgrading |
| Declare build, test and lint targets | `@smthrs/targets` | `Smithers.Package`, `Smithers.NodeTest`, `Smithers.Typecheck` in `PACKAGE.ts`; run with `pnpm exec smithers-build test //<pkg>:test` |

## Platform rule (Will, 2026-10-19)

A host package owns all platform code: `node:*` modules, `Bun.*`, the DOM,
child processes, sockets and the filesystem. The host packages are
[`@smthrs/platform-node`](../packages/smithers/flows/platform-node/README.md),
[`@smthrs/platform-bun`](../packages/smithers/flows/platform-bun/README.md),
[`@smthrs/platform-browser`](../packages/smithers/flows/platform-browser/README.md) and
[`@smthrs/platform-cloudflare`](../packages/smithers/flows/platform-cloudflare/README.md).
They hand that code to every other package as injected Effect services and
layers. Every other library must import and run in a browser, a Cloudflare
Worker, Node and Bun, and consumers import only from a package's root entry. A
package that breaks this has a bug.

Web-standard globals that every one of those four runtimes ships, such as
`fetch`, `crypto.subtle`, `crypto.getRandomValues`, `TextEncoder`, `URL`,
streams and `AbortController`, are not platform code. A library may call them
directly. Prefer Effect's own service where one exists, such as `HttpClient`
for HTTP and `Crypto` for random bytes and digests, so tests can inject
faults.

Apps, command-line programs and repository flows are composition roots: each
picks a host and may run on one runtime. `@smthrs/ui`, `@smthrs/repo-view` and
`@smthrs/terminal-frame` render React, so they run in the browser.

**How "Runs on" was checked (2026-10-19).** For every workspace package, esbuild
0.28.2 bundled the root entry with `platform: "browser"` and the conditions
`workerd`, `worker`, `browser`, `import` and `default`. It recorded every
`node:`, `bun:` or bare Node built-in import the bundle reached. **All** means
the root entry reached none, so it imports in a browser, a Worker, Node and
Bun. This is a static import check, not an execution test. Globals such as
`process` and `Buffer` are not covered, and a library may still need a host
layer, such as a SQL driver or `FileSystem`, to do real work. The repository's
gate for this is `//packages/repo-targets:webBundleContract`, which bundles
the entry points listed in `packages/repo-targets/browser/browser-contract.mjs`
twice, for a browser and with the conditions wrangler passes for a Worker. Each
bundle also fails on host access the bundler cannot see
(`packages/repo-targets/src/HiddenHostAccess.ts`): a dynamic `import()` or
`require()` whose specifier is an expression, and a `process.getBuiltinModule`
call that is neither an optional call nor inside a `try` block. A module of a
workspace package outside the host packages is held to the platform rule
itself: any `getBuiltinModule` call, feature detection or not, any read of the
ambient `process`, `Bun` or `Deno` global, and any `node:` or `bun:` specifier
fails the gate, unless the table below lists that module. Until 2026-10-20 it
checked resolved imports only, and `@smthrs/sandbox`, and with it the
`@smthrs/flows` root, passed while `SandboxMerge` loaded
`@smthrs/jj/node/NodeJj` through `import(adapter)` and `MicrosandboxSandbox`
set V8 flags through an optional `getBuiltinModule` call. The Microsandbox
provider now takes the host's `GarbageCollector` service. `@smthrs/harness` and `@smthrs/platform-cloudflare` also have
Worker smoke tests (`test/WorkerdSmoke.test.ts`, run with
`FLOWS_WORKERD_SMOKE=1`).

Since 2026-10-20 the gate also loads each entry point in a dedicated web
worker, where an app runs its engine and agent. It bundles the entry with the
`worker` and `browser` conditions, and again with `browser` alone as Vite builds
a worker, with tree shaking off as a dev server evaluates every module, and
imports it in a DOM-less worker thread. Until then the `@smthrs/agent` root
passed while `@mdx-js/mdx`, through `@smthrs/registry`'s `Prompt`, loaded
`decode-named-character-reference`, which calls `document` at load under
`browser` and killed the app's engine worker.

### Known violations: the root entry reaches platform code

| Package | Root entry reaches | Through |
| --- | --- | --- |
| `@smthrs/testing` | `node:fs`, `node:crypto`, `node:path`, `node:sqlite`, `node:net`, `node:tls` | `src/FixtureStore.ts`; the `@smthrs/database` Node and Postgres test layers |
| `@smthrs/harness-detect` (private) | `node:path` | `src/Probe.ts`, `src/internal/Read.ts` |
| `@smthrs/fs` (private) | `node:fs`, `node:child_process`, `node:async_hooks` and more | the `incur` CLI dependency; `@smthrs/build-cli` `src/Positionals.ts` |
| `@smthrs/migrate` | `node:sqlite`, `node:crypto`, `node:fs`, `node:child_process` | `src/RunState.ts`, `src/Checks.ts`, `src/flow/*` |
| `@smthrs/targets` | `node:fs`, `node:crypto`, `node:child_process`, `node:http` and more (32 source files) | `src/Package.ts`, `src/RemoteCache.ts`, `src/LlmLint.ts` and others |
| `@smthrs/repo-targets` (private) | the same as `@smthrs/targets` | its `@smthrs/targets` import |

### Known violations: a library module reaches the host at run time

The browser gate lists these modules in `KNOWN_HOST_ACCESS`
(`packages/repo-targets/browser/browser-contract.mjs`) and fails when one of
them stops reaching the host, so the list only shrinks.

| Module | Reaches | For |
| --- | --- | --- |
| `@smthrs/engine-store` `src/internal/HostReflection.ts` | `getBuiltinModule("node:util/types")` | Proxy and native-error detection |
| `@smthrs/engine` `src/internal/Diagnostic.ts` | `getBuiltinModule("node:util")` | Proxy detection |
| `@smthrs/run-store` `src/Ownership.ts` | `process.kill(pid, 0)` | `sameHostPidProbe` |
| `@smthrs/engine-store` `src/OwnerIdentity.ts` | `process.pid` | The run owner's identity |
| `@smthrs/kernel` `src/ChildProcessSpawner.ts` | `process.platform`, `process.env` | A child's environment |
| `@smthrs/integrations` `src/Environment.ts` | `process.env` | Configuration |
| `@smthrs/sandbox` `src/ContainerSandbox/existing.ts`, `src/DirectorySandbox/make.ts`, `src/RemoteChildProcessSpawner/layer.ts` | `process.env` | A command's environment |

### Known violations: platform code on a subpath outside a host package

These roots are clean, but the package carries a platform adapter that belongs
in a host package.

| Package | Subpath | Platform code |
| --- | --- | --- |
| `@smthrs/database` | `node/NodeDatabase`, `bun/BunDatabase`, `postgres/PostgresDatabase` | `node:sqlite`, `bun:sqlite`, `node:crypto` |
| `@smthrs/jj` | `node/NodeJj` | `node:child_process`, `node:fs` |
| `@smthrs/gateway` | `node/NodeGateway`, `bun/BunGateway` | `node:http`, `node:net`, `Bun.serve` |
| `@smthrs/observability` | `NodeOtel` | `@opentelemetry/sdk-trace-node`, which needs `async_hooks` |
| `@smthrs/testing` | `ModelServer`, `ProcessTable`, `TurnLog` | `node:http`, `node:child_process`, `node:fs` |

## Model calls and agents

| Package | Path | Use it to | Call | Runs on |
| --- | --- | --- | --- | --- |
| [`@smthrs/model`](../packages/smithers/agent/model/docs/README.md) | `packages/smithers/agent/model` | Call Anthropic Messages, OpenAI Responses, OpenAI Chat Completions or any server speaking one of them, and get one typed event stream. Also the Jev judge (`Classifier`, `Evaluator`). | `Route.openaiChatCompatible({ id, providerName, baseUrl, path?, apiKey })`, `Route.layer(route)` with `RequestExecutor.layer` and an Effect `HttpClient`, then `(yield* Model.Model).stream(request)`; `ModelEvent.settledMessage`; `ModelProxy.serve` and `ModelProxy.layerClient` to serve a model over HTTP | All |
| [`@smthrs/agent`](../packages/smithers/agent/docs/README.md) | `packages/smithers/agent` | Run a durable model loop with tools, budgets, rate-limit parking and schema-checked answers. | `AgentAction.make("ns/Name", { payload, output, seat, system, prompt })`, `AgentSession.layer`, `Agent.Agent`; `ModelStep.run` for one durable model call | All, a dedicated web worker included; standard tools need host `FileSystem` and `ChildProcessSpawner` |
| [`@smthrs/harness`](../packages/smithers/agent/harness/docs/README.md) | `packages/smithers/agent/harness` | Build your own agent host on the cell loop: each model turn writes JavaScript that runs in a persistent QuickJS realm and reaches the world only through `ctx.call`. `@smthrs/agent` already composes it. | `CellTurn.run`, `FlowBinding.make`; the sandbox is `@smthrs/harness/QuickJSSandbox`, and the QuickJS build every realm compiles is `QuickJSVariant` and portable shared `QuickJSLifecycle` primitives on the root | All; Worker smoke test |
| [`@smthrs/chain`](../packages/smithers/agent/chain/docs/README.md) (private) | `packages/smithers/agent/chain` | Run a crash-safe loop where a model writes a script whose only side effects are journaled `ctx.call`s. | `Chain.run({ goal })`, `ModelAuthor.layer`, `Journal.layerMemory` | All |
| [`@smthrs/model-host`](../packages/smithers/agent/model-host/README.md) (private) | `packages/smithers/agent/model-host` | Choose a host's model from configuration, and run a chat turn with the owner's provider key that writes each frame to the backend's durable chat journal. | `HostModel.layerConfig`, `HostModel.make`, `createModelTurnHandler`, `runDurableChatTurn` | All; the Node host injects `FetchTransport.observe` from `@smthrs/platform-node` |
| [`@smthrs/std`](../packages/smithers/agent/std/docs/README.md) | `packages/smithers/agent/std` | Give an agent read, write, edit, grep, glob, bash, test, LSP, fetch, web search and apply-patch tools with bounded output and SSRF-safe fetch. | `Manifest.flows`, `Manifest.handlers`, `Read.run`, `Bash.run`, `Edit.run` | All; file, shell and search tools need host `FileSystem` and `ChildProcessSpawner`, and web tools a pinning host: `EgressHttpClient.layer` from `@smthrs/platform-node` |
| [`@smthrs/mcp`](../packages/smithers/mcp/docs/README.md) | `packages/smithers/mcp` | Connect to an MCP server over stdio or Streamable HTTP and expose its tools as flows. | `McpFlows.connected({ server, command \| url, env, include })`, then `.bindings()`; `McpClient.connect` | All; stdio needs a host `ChildProcessSpawner` |
| [`@smthrs/registry`](../packages/smithers/agent/registry/docs/README.md) | `packages/smithers/agent/registry` | Discover `flow.ts`, `flow.mdx` and `SKILL.md` flows without running them, list them, show them to a model, or run one by name; read one `flow.ts`'s declaration and tag from text you hold. | `Registry.layerProject({ root })`, `Registry.layer({ sources })`, `Discovery`, `ModuleFlow.fromModule` | All; `Discovery` needs host `FileSystem` |
| [`@smthrs/memory`](../packages/smithers/agent/memory/docs/README.md) | `packages/smithers/agent/memory` | Keep durable agent memory: facts, notes and message history, with keyword, full-text or semantic recall. | `Flows.runRemember`, `Flows.runRecall`, `MemoryStore.layer`, `RecallKeyword.layer`, `Opening.Sources`, `Opening.select` | All; needs a SQL driver layer |
| [`@smthrs/plugin`](../packages/smithers/agent/plugin/docs/README.md) | `packages/smithers/agent/plugin` | Add a Vite-style typed plugin and hook kernel to an Effect host; decode `plugin.json` manifests and fold them into one set of views, slots, commands and keybindings with typed refusals. | `Kernel.make([plugins])`; `Manifest.decode(json)`, `Load.load(hostFacts, candidates)` | All |
| [`@smthrs/harness-detect`](../packages/smithers/agent/harness-detect/README.md) (private) | `packages/smithers/agent/harness-detect` | Find installed coding-agent CLIs (Claude Code, Codex, Gemini, OpenCode and others), their versions, sign-in state and model flag. | `detectHarnessesWith(host)`, `harnessModelSpec`, `harnessModels` | Node; **violation** |
| [`@smthrs/fs`](../packages/smithers/agent/fs/docs/README.md) (private) | `packages/smithers/agent/fs` | Expose a flows directory as named, schema-checked commands for a shell, HTTP, OpenAPI or MCP. | `FileRouter.scan({ root })`, `Command.make(routes)`, `Incur.createCli` | Node; **violation** |

Which to pick: one model call is `ModelStep.run` from `@smthrs/agent`, a
durable step over `@smthrs/model`'s `Model` and `Route`. An agent with tools is
`@smthrs/agent`. Write against `@smthrs/harness` only when you build a new
agent host. A host that answers with a model chosen by configuration provides
`HostModel.layerConfig` from `@smthrs/model-host`. A browser never holds a
provider key: its model calls go to a host that runs `ModelProxy.serve`, and
the browser provides `ModelProxy.layerClient` as its `Model`.

## Flows and durability

| Package | Path | Use it to | Call | Runs on |
| --- | --- | --- | --- | --- |
| [`@smthrs/flow`](../packages/smithers/flows/flow/README.md) | `packages/smithers/flows/flow` | Declare durable steps (actions) and the flows that compose them, with retries, durable timers and waits for a person, a webhook or a poll. | `Flow.make("<tag>", { payload, success, body })`, `Action.make`, `.toLayer(impl)`, `RetryPolicy.make`, `DurableClock.sleep`, `HumanTask`, `WaitFor` | All |
| [`@smthrs/flows`](../packages/smithers/flows/README.md) | `packages/smithers/flows` | Get the whole durable engine from one dependency, and compose it over a host's SQL client and services. | `Runtime.layer(options, stepBoundary, workspaceSandbox, registration)`; a Node program calls `NodeRuntime.layerHost` from `@smthrs/platform-node` instead | All |
| [`@smthrs/core`](../packages/smithers/flows/core/docs/README.md) | `packages/smithers/flows/core` | Inspect a flow before it runs: build its graph, lower Markdown or `SKILL.md` into flow signatures, declare placement and effects. | `Graph.build(flow, payload)`, `Markdown.lowerMarkdown`, `Placement.sandbox` | All |
| [`@smthrs/plan`](../packages/smithers/flows/plan/docs/README.md) | `packages/smithers/flows/plan` | Turn declared work into a hashable keyed action graph and diff two versions. | `Plan.compile`, `PlanDiff.diff`, `Node.capture` | All |
| [`@smthrs/plan-store`](../packages/smithers/flows/plan-store/docs/README.md) | `packages/smithers/flows/plan-store` | Keep compiled plans in SQL as append-only generations. | `PlanStore.layer`, `Migrations.layer` | All |
| [`@smthrs/engine`](../packages/smithers/flows/engine/README.md) | `packages/smithers/flows/engine` | Execute flows in memory for tests, or serve them over RPC and HTTP. | `FlowEngine.layerMemory`, `FlowProxy`, `FlowProxyServer` | All |
| [`@smthrs/engine-store`](../packages/smithers/flows/engine-store/README.md) | `packages/smithers/flows/engine-store` | Compose the durable engine yourself: attempts, owner fencing, durable waits, cache admission and retention. | `EngineStore.layer({ owner, journalSource })`, `Migrations.layer` | All |
| [`@smthrs/journal`](../packages/smithers/flows/journal/README.md) | `packages/smithers/flows/journal` | Keep an append-only, redacted, owner-fenced event history for a run. | `SqlJournal.layer`, `Journal.Journal`, `Redaction` | All |
| [`@smthrs/run-store`](../packages/smithers/flows/run-store/README.md) | `packages/smithers/flows/run-store` | Keep one row per run with fenced ownership. | `RunStore.RunStore`, `AttemptStore` | All |
| [`@smthrs/step-cache`](../packages/smithers/flows/step-cache/README.md) | `packages/smithers/flows/step-cache` | Reuse a finished step's result by input digest, across runs or machines. | `CacheStore.layer`, `RemoteCacheStore`, `CombinedCacheStore` | All |
| [`@smthrs/time-travel`](../packages/smithers/flows/time-travel/README.md) | `packages/smithers/flows/time-travel` | Replay, inspect, fork or rewind a run at a journal frame. | `TimeTravel.layer`, then `replay`, `inspect`, `fork`, `rewind` | All; fork and rewind need jj from the host |
| [`@smthrs/patterns`](../packages/smithers/flows/patterns/README.md) | `packages/smithers/flows/patterns` | Use a bounded pattern: review loop, saga, escalation, bounded fan-out, check suite or merge queue. | `ReviewLoop.run(goal, { maxRounds, produce, review, revise })`, `Saga.run`, `Bounded.all` | All |
| [`@smthrs/database`](../packages/smithers/flows/database/README.md) | `packages/smithers/flows/database` | Write SQLite or Postgres with transactions, lock-conflict retries and one shared migration ladder. | `DurableWriter.layer()`, `Migrations.layer(sets)`; drivers on subpaths | All for the root; driver subpaths are a **violation** |
| [`@smthrs/artifacts`](../packages/smithers/flows/artifacts/README.md) | `packages/smithers/flows/artifacts` | Store and fetch large blobs by SHA-256 with verified reads, locally or through a shared HTTP cache; cache bytes under an immutable key, such as a file at a commit SHA, over any Web Cache API backend. | `ArtifactStore.layerFileSystem({ directory })`, `ArtifactStore.layerMemory`, `RemoteArtifacts.layer`; `ImmutableCache.readThrough`, `ImmutableCache.layerMemory` | All |
| [`@smthrs/keys`](../packages/smithers/flows/keys/docs/README.md) | `packages/smithers/flows/keys` | Derive a deterministic key for structured data: a cache key, row id or idempotency token. | `deriveKey`, `StoredKey` | All |
| [`@smthrs/canonical`](../packages/smithers/flows/canonical/docs/README.md) | `packages/smithers/flows/canonical` | Serialize JSON byte-stably (RFC 8785) before hashing or comparing. | `canonicalize`, `Canonical` | All |
| [`@smthrs/crypto`](../packages/smithers/flows/crypto/docs/README.md) | `packages/smithers/flows/crypto` | Compute SHA-256 digests without `node:crypto`; provide Effect's `Crypto` over the global WebCrypto. | `digest`, `digestSync`, `WebCrypto.layer` | All |
| [`@smthrs/secrets`](../packages/smithers/flows/secrets/docs/README.md) (private) | `packages/smithers/flows/secrets` | Keep a secret's value out of the guest that uses it: placeholders per scope, per-secret hosts and methods, header-only substitution over HTTPS, no redirects followed, an audit by name, and answers scrubbed of every echoed form across chunks. | `Placeholder.minter`, `Binding.Binding`, `Binding.checkValue`, `Egress.forward`, `Egress.execute`, `Egress.Vault`, `Egress.Audit`, `Scrub.make` | All |

Durable execution needs a SQL store, so it runs on Node or Bun through
`NodeRuntime` in `@smthrs/platform-node` or `BunRuntime` in
`@smthrs/platform-bun`, in Cloudflare Durable Objects over Postgres through
`@smthrs/platform-cloudflare`, and in a browser tab's dedicated worker over
SQLite on OPFS through `@smthrs/platform-browser`, whose `browserTest` target
kills Chromium mid-run and checks the run resumes. The
[support matrix](../apps/site/docs/reference/support-matrix.md) lists each
runtime's evidence.

## Hosts, permissions and machines

| Package | Path | Use it to | Call | Runs on |
| --- | --- | --- | --- | --- |
| [`@smthrs/platform-node`](../packages/smithers/flows/platform-node/README.md) | `packages/smithers/flows/platform-node` | Provide the filesystem, process, jj and HTTP services on Node, with symlink-safe file access, confined processes, orphan reaping and proxy-aware egress; run durable flows on Node, and a child flow's own code in a sandbox. | `NodeHost.layer`, `NodeHost.layerAt(root)`, `NodeHost.layerContainedAt`, `ScopedProcess.spawn`, `NodeRuntime.layerHost(options, registration)`, `SandboxedFlow.execute`, `TestNodeRuntime.durableEngine`, `NodeGarbageCollector.layer`, `NodeLanguageServer.layer`; `EgressHttpClient.layer` also provides the name resolver web tools check | Node (host) |
| [`@smthrs/platform-bun`](../packages/smithers/flows/platform-bun/README.md) | `packages/smithers/flows/platform-bun` | Provide the same host services on Bun, and run durable flows on Bun. | `BunHost.layer`, `BunHost.layerAt(root)`, `BunHost.layerContainedAt`, `BunRuntime.layerHost(options, registration)`, `BunGarbageCollector.layer` | Bun (host) |
| [`@smthrs/platform-browser`](../packages/smithers/flows/platform-browser/README.md) | `packages/smithers/flows/platform-browser` | Provide `FileSystem`, process spawning and jj in a browser tab over ZenFS, just-bash and wasm jj, and host the durable engine in a dedicated worker over SQLite on OPFS, with Web Locks leader election across tabs (`steal` for a focused tab); share the app's own SQLite database between tabs through the leader; keep immutable content in Cache Storage; hold a terminal's reconnecting socket; run TypeScript's language service in a dedicated worker as `@smthrs/std`'s `LanguageServer`. | `BrowserHost.layer({ bash, fs, jj })`, `BrowserServices.layer({ bash, fs })`, `BrowserRuntime.run`, `BrowserEngine.layer`, `SharedSqlite.open`, `WebLock.hold`, `BrowserCache.layer`, `TerminalSocket.connect`, `BrowserLanguageServer.make`, `BrowserLanguageServer.serve` | Browser (host) |
| [`@smthrs/platform-cloudflare`](../packages/smithers/flows/platform-cloudflare/README.md) | `packages/smithers/flows/platform-cloudflare` | Run the durable engine in Cloudflare Workers: one Durable Object per execution, woken by its alarm, over Postgres through Hyperdrive, with the filesystem, processes and jj refusing; keep immutable content in the edge cache; give a container Durable Object's container a wake, browser terminals and a sandbox session. | `ExecutionObject.start`, `ExecutionObject.alarm`, `CloudflareRuntime.layer({ hostId, executionId }, registration)`, `CloudflareHost.layer`, `EdgeCache.layer`, `SandboxObject.wake`, `ContainerTerminal.attach`, `ContainerSession.make` | Cloudflare Worker (host) |
| [`@smthrs/kernel`](../packages/smithers/flows/kernel/README.md) | `packages/smithers/flows/kernel` | Check every filesystem, process, network and jj effect against allow, deny or ask rules before it runs. | `HostServices.layer`, `GrantStore.layer({ attended, rules })`, `Workspace.layer(root)`, `ProcessLedger.layer` | All |
| [`@smthrs/capability`](../packages/smithers/flows/capability/README.md) | `packages/smithers/flows/capability` | Name an operation as a capability and evaluate permission rules, without enforcing them. | `Capability.make`, `Permission.evaluate` | All |
| [`@smthrs/jj`](../packages/smithers/flows/jj/README.md) | `packages/smithers/flows/jj` | Snapshot, restore or diff a jj working copy, and add or forget workspaces, without parsing `jj` output. | the `Jj` service and the `RepositoryMutation` fence; `NodeJj.layerAt(root)` and `NodeJj.layerRepositoryMutation` from `@smthrs/jj/node/NodeJj`, `BrowserJj.layer` | All for the root; `node/NodeJj` is a **violation** |
| [`@smthrs/sandbox`](../packages/smithers/flows/sandbox/README.md) | `packages/smithers/flows/sandbox` | Run a flow's files and commands on a container, microVM, Kubernetes Pod, Vercel, Daytona, AWS or Cloudflare sandbox, or a scratch directory. | `Sandbox.layerHost(provider, { session })`, `ContainerSandbox.make`, `MicrosandboxSandbox.make`, `CloudflareSandbox.make`, `SandboxMerge.apply`, `SandboxTools.execute` | All; providers need a host spawner or a Worker binding, `MicrosandboxSandbox.make` needs the host's `GarbageCollector`, and `SandboxMerge.apply` needs the host's `RepositoryMutation` |

## Control, GitHub and events

| Package | Path | Use it to | Call | Runs on |
| --- | --- | --- | --- | --- |
| [`@smthrs/control`](../packages/smithers/control/README.md) | `packages/smithers/control` | Plan, start, approve, deny, steer, cancel, resume, list or watch runs from code, through the API the CLI uses. | `Control.Control`; `ControlLive.layer` in process, `ControlClient.layer({ url, credential })` over RPC, `ControlServer.layerHttp` | All |
| [`@smthrs/gateway`](../packages/smithers/gateway/README.md) | `packages/smithers/gateway` | Serve or call the HTTP and WebSocket surface for control RPC, sync, projections and health. | `GatewayServer.layer`, `GatewayProjection`, `GatewaySchema`; servers on `node/NodeGateway` and `bun/BunGateway` | All for the root; server subpaths are a **violation** |
| [`@smthrs/integrations`](../packages/smithers/agent/integrations/docs/README.md) | `packages/smithers/agent/integrations` | Call the GitHub API one request at a time, with each failure classified for the flow engine's retry (`Retry-After` included), write back comments, labels and check runs durably, verify webhooks and run OAuth PKCE. HTTP goes through the Effect `HttpClient` you provide. | `GitHub.GitHubClient.make` or `.layer` with `FetchHttpClient.layer` from `effect/http`, `GitHub.Actions.CommentOnIssue`, `GitHub.Actions.AddLabels`, `Core.Channel.make` | All |
| [`@smthrs/effect-code-storage`](../packages/effect-code-storage/README.md) (private) | `packages/effect-code-storage` | Import a public GitHub repository into Code Storage, Pierre's git hosting, and read its files and commits, with a short WebCrypto-signed token per request and typed, bounded failures; read any git remote's default branch with no credential. | `CodeStorage.layerConfig`, then `createRepo`, `pullUpstream`, `listFiles`, `readFile`, `listCommits`; `GitRemote.head` | All |
| [`@smthrs/triggers`](../packages/smithers/agent/triggers/docs/README.md) | `packages/smithers/agent/triggers` | Start flows on a durable cron schedule or a verified webhook, with overlap and catch-up rules. | `Trigger.make({ id, flowId, cron })`, `Scheduler.layer`, `SqlTriggerStore.layer`, `Webhook.make` | All |
| [`@smthrs/notifications`](../packages/smithers/notifications/README.md) | `packages/smithers/notifications` | Keep a durable, bounded queue of notifications per run, send delayed, coalesced alerts to a webhook, route a person's notifications with their acts merged across devices, and send a message by email (Resend) or Telegram. | `NotificationQueue.layer`, `Alerts.layer`, `Alerts.layerWebhook`, `Inbox.route`, `Inbox.ack`, `Channels.layer` | All |
| [`@smthrs/sync`](../packages/smithers/flows/sync/README.md) | `packages/smithers/flows/sync` | Replay a run's journal and follow it live over RPC or WebSocket, or serve that read path; show who is on a page (presence rooms); edit one text together (`SharedText`). | `SyncClient.layer`, `SyncServer.layer`, `SyncAuth.layer`, `PresenceRoom`, `PresenceSocket`, `SharedText` | All |
| [`@smthrs/observability`](../packages/smithers/flows/observability/README.md) | `packages/smithers/flows/observability` | Send logs, metrics and traces to an OTLP collector, or mirror a run's logs into its journal. | `Otlp.layerFetch({ baseUrl, serviceName })`, `Logger.layerStructuredJson`, `JournalLogger.layerJournalForwarding` | All for the root; `NodeOtel` is a **violation** |
| [`@smthrs/errors`](../packages/errors/README.md) | `packages/errors` | Raise or classify integration failures with `SmithersError` and its five codes. | `SmithersError`, `isSmithersError` | All |
| [`@smthrs/rpc`](../packages/rpc/README.md) (private) | `packages/rpc` | Share zod schemas, `/api` route constants, card schemas and failure codes between the app, the Worker and the TUI. | Every module as a namespace from the root, such as `Cards` and `ConfiguredModel`. Existing files still import `@smthrs/rpc/<Module>` paths until they migrate | All |

## Local state and sync

Two libraries that will move to their own repository as public packages
(proposed names `effect-tanstack-db` and `effect-electric`). They depend on no
other `@smthrs` package except each other, and record with plain Effect logs,
spans and metrics, so the host's exporters pick them up.

| Package | Path | Use it to | Call | Runs on |
| --- | --- | --- | --- | --- |
| [`@smthrs/effect-tanstack-db`](../packages/effect-tanstack-db/README.md) (private) | `packages/effect-tanstack-db` | Hold app state in TanStack DB collections as scoped Effect services: every row checked by an Effect `Schema`, changes and live query results as `Stream`s, mutations as Effects with typed errors. Keep rows on the device in SQLite, and send writes through a durable outbox that stores each before sending it and retries until it succeeds or is refused. | `Collection.local`, `Collection.make` for a sync adapter (with `persist` to keep its rows), `Collection.persisted`, `restored`, `LiveQuery.make`, `setWindow`, the `Query` expressions; `Persistence.layer({ open, make, coordinator })`; `Outbox.layer`, `outbox.transact`, `Outbox.lockLeader` over the host's lock service; `Migrations` to carry stored data and queued writes across builds; framework bindings read `collection.tanstack` | All, with the host's database, storage and leader passed in; peers `effect` 4.0.5, `@tanstack/db` 0.15.1, `@tanstack/db-sqlite-persistence-core` 0.4.11, optional `@tanstack/offline-transactions` 1.1.3 |
| [`@smthrs/effect-electric`](../packages/effect-electric/README.md) (private) | `packages/effect-electric` | Sync a collection from an Electric shape with a `Schedule` retry policy, sync status as a `Stream` and txid or match waits, keep its rows and resume state on the device, and serve the shapes from your own server through a proxy that fixes the table, drops subset requests, keeps responses out of HTTP caches and refuses a request it can't decide. | `ElectricCollection.make` (`persist`, `restored`), `SyncPolicy.backoff`, `ElectricCollection.statusOf`; `ShapeSource.layerFaulty` to test unhappy paths by injection; `ShapeProxy.make` (`cache`, a per-request `shape` that may fail `ShapeProxy.Refused`, `secretAs`), `ShapeProxy.config` | All; peers `effect` 4.0.5, `@tanstack/db` 0.15.1, `@electric-sql/client` 1.5.28, `@tanstack/electric-db-collection` 0.6.2, `@tanstack/db-sqlite-persistence-core` 0.4.11 |

## UI

| Package | Path | Use it to | Call | Runs on |
| --- | --- | --- | --- | --- |
| [`@smthrs/ui`](../packages/smithers/ui/README.md) (private) | `packages/smithers/ui` | Build any React UI from shared components styled only with theme tokens, in light and dark. | `SmithersUiStyles` (add `withTheme` in a standalone app), `Button`, `Card`, `StatusPill`, `Badge`, `KpiStat`, `EmptyState`, `ChatTranscript`, `ChatComposer`, `ToolCall`, `DiffHunks`, `FileTree`, `Markdown`, `Wordmark`; heavy renderers such as `Terminal` and `ChartContainer` on `@smthrs/ui/adapters/*` | Browser, React 19.2.8 |
| [`@smthrs/repo-view`](../packages/smithers/ui/repo-view/docs/README.md) (private) | `packages/smithers/ui/repo-view` | Show a repository with the heavy renderers `@smthrs/ui` leaves out: the file tree beside a directory and its README or a file, a file on Shiki, a patch on pierre, the Milkdown editor, and the live editors several people type in at once, with a language server's marks, hover card, keyboard cursor and Symbols pane on code. Grammars, themes and Milkdown load on first use. | `RepoView`, `CodeFileView`, `SymbolsPane`, `languageForFile`, `disposeCodeViewPool`, `PierreDiffView`, `patchToCodeViewItems`, `MarkdownEditor`, `CodeEditor`, `LiveMarkdownEditor`, `RepoViewStyles` | Browser, React 19.2.8 |
| [`@smthrs/terminal-frame`](../packages/smithers/ui/terminal-frame/docs/README.md) (private) | `packages/smithers/ui/terminal-frame` | Show a live shell's untrusted output: xterm.js in an opaque-origin frame whose CSP allows no network, talking to the page over one port. | `TerminalFrame`, `terminalFrameRuntime` | Browser, React 19.2.8 |
| [`@smthrs/views`](../packages/smithers/ui/views/docs/README.md) | `packages/smithers/ui/views` | Show UI a model writes as safe arbitrary output: check a renderer's TSX module, render it to HTML in a bounded QuickJS realm, write the frame's pinned CSP, and admit only its declared events; read a repository's declared home and who sees each section; ask from a server whether an outside page shows in a frame. Framework-free; `@smthrs/ui` supplies the presentation bundle, `GeneratedView` and `RepositoryHome`. | `ViewCode.check`, `PresentationRealm.make` or `.layer({ bundle })` over `QuickJSVariant` from `@smthrs/harness`, `realm.render`, `realm.interact`, `ViewCsp.frameDocument`, `Bridge.receive`, `Interactions.parse`, `Home.read`, `Home.visible`, `WebPage.check` | All; Worker test in local workerd |
| [`@smthrs/ui-styleguide`](../packages/smithers/ui/ui-styleguide/README.md) (private) | `packages/smithers/ui/ui-styleguide` | Get the raw CSS tokens and palette registry under `@smthrs/ui`. App code normally gets them through `@smthrs/ui`. | `themeCss`, `themeRegistry`, `contrastRatio` | All |

Add `"@smthrs/ui": "workspace:*"`; npm has only an old 0.35.0. A reusable piece
of UI goes into `@smthrs/ui` with its test and docs, not into an app.

## Build, CLI and release

| Package | Path | Use it to | Call | Runs on |
| --- | --- | --- | --- | --- |
| [`@smthrs/cli`](../packages/smithers/docs/reference/cli/README.md) | `packages/smithers` | Plan, start and watch flows, handle runs and approvals, run evals and run target verbs from one command, `smthrs`. | `smthrs flow list\|plan\|start <name> --data '<json>' --wait`, `smthrs runs list\|logs\|cancel`, `smthrs approvals list\|approve\|deny`, `smthrs eval run`, `smthrs test //<pkg>:test` | Node (program) |
| [`smthrs`](../packages/smthrs-deprecation/docs/replacements.md) | `packages/smthrs-deprecation` | Run `npx smthrs <verb>` without installing `@smthrs/cli`. Importing it throws the 1.0 migration notice. | `npx smthrs@next <verb>` | Node (program) |
| [`@smthrs/build`](../packages/smithers/build/docs/README.md) | `packages/smithers/build` | Install dependencies as a keyed flow held to the declared runtime and pnpm version. | `Install.Install`; `smithers-build install --workspace <path>` | All; needs a host spawner |
| [`@smthrs/build-cli`](../packages/smithers/build/build-cli/docs/cli.md) | `packages/smithers/build/build-cli` | Run `PACKAGE.ts` targets with content-addressed caching, sandboxing and affected-target selection. | `smithers-build test\|run\|ci\|query\|graph\|affected` | Node (program) |
| [`@smthrs/targets`](../packages/smithers/build/targets/docs/rules.md) | `packages/smithers/build/targets` | Declare targets in `PACKAGE.ts` or `WORKSPACE.ts`, including generated CI YAML, secrets and LLM review. | `Smithers.Package`, `Smithers.NodeTest`, `Smithers.Typecheck`, `Smithers.LlmLint`, `Smithers.file`, `Smithers.glob` | Node; **violation** |
| [`@smthrs/repo-targets`](../packages/repo-targets/README.md) (private) | `packages/repo-targets` | Reuse this repository's standard per-package targets, review rules and import rules in a `PACKAGE.ts`. | `BuildAndCheckTypeScriptPackage`, `ReviewDocsAgainstCode`, `ReviewJsdocAgainstCode`, `ImportRules({ cwd, rules })` | Node; **violation** through `@smthrs/targets` |
| [`@smthrs/build-infra`](../packages/smithers/build/infra/README.md) (private) | `packages/smithers/build/infra` | Deploy or change the hosted remote build cache at `build.smithers.sh`. | its `deploy` and `plan` scripts; `worker/CacheWorker.ts` | Cloudflare Worker (program) |
| [`@smthrs/migrate`](../packages/smithers/migrate/docs/README.md) | `packages/smithers/migrate` | Upgrade a 0.x JSX project to 1.0 flows with an auditable report. | `smithers-migrate` or `smthrs migrate`; `Scan`, `Detect`, `Report` | Node; **violation** |

## Testing and evals

| Package | Path | Use it to | Call | Runs on |
| --- | --- | --- | --- | --- |
| [`@smthrs/testing`](../packages/testing/docs/api.md) | `packages/testing` | Test flows deterministically with scripted or recorded models, a memory engine, plan and journal assertions and conformance suites. | `ScriptedModel.make`, `CachedModel.make`, `TestHost.layer`, `PlanAssertions`, `JournalAssertions`, `Conformance.coreSuite`; `@smthrs/testing/Vitest` | Node; **violation** |
| [`@smthrs/evals`](../packages/smithers/agent/evals/docs/quickstart.md) | `packages/smithers/agent/evals` | Run a fixed eval suite against a committed baseline with a CI exit code. | `Suite.make`, `CaseExecutor.make`, `Runner.run`, `Baseline.write`, `Regression.compare`, `Gate.check`; `smthrs eval run\|baseline\|compare` | All |
| [`@smthrs/scorers`](../packages/smithers/agent/scorers/docs/quickstart.md) | `packages/smithers/agent/scorers` | Grade a flow's output with exact, contains, rubric or tests-pass scorers and keep the scores. | `Scorer.make`, `Scorers.exact`, `Scorers.rubric`, `Scorers.testsPass`, `Rubric.make`, `Scoring.runBatchCorrelated` inside caller-owned flow actions | All |
| [`@smthrs/eval-agent`](../packages/smithers/agent/regression/README.md) (private) | `packages/smithers/agent/regression` | Check that a change to the `@smthrs/agent` loop did not regress, with offline deterministic cases. | `bun packages/smithers/agent/regression/run.ts` | Bun (program) |
| [`@smthrs/eval-review-seeded-bugs`](../.smithers/flows/review/seeded-bugs/README.md) (private) | `.smithers/flows/review/seeded-bugs` | Measure the review flow's recall and precision on 16 seeded fixture repositories. | `bun test .smithers/flows/review/seeded-bugs`; `run.ts --live` | Bun (program) |
| [`@smthrs/eval-authoring`](../evals/authoring/README.md) (private) | `evals/authoring` | Validate or upload the flow-authoring fine-tune dataset. | `pnpm exec smithers-build test '//evals/authoring:test'` | Bun (program) |
| [`@smthrs/eval-swebench`](../packages/smithers/agent/harness/benchmarks/swebench/README.md) (private) | `packages/smithers/agent/harness/benchmarks/swebench` | Benchmark the harness on SWE-bench Verified. Operators run it; it spends real tokens. | `./run-sample.sh`, `./evaluate.sh`, `scorecard.ts` | Bash, Node, Python, Docker |

## Repository flows

`.smithers/flows` (`@smithers/release-workflows`, private) holds this
repository's own flows. Start one instead of writing a script, and never add a
top-level `scripts/` folder. A flow is named by its directory path. Use the
workspace CLI, `pnpm exec smthrs`, because an installed release can lag the
source. See the [flows README](../.smithers/flows/README.md).

| Flow | Use it to | Start |
| --- | --- | --- |
| `land` | Commit the shared checkout to `main`, running the gates first when it pushes. | `pnpm exec smthrs flow start land --data '{"message":"...","push":true,"tests":["..."]}' --wait`; fallback `pnpm commit` |
| `issue-claim` | Claim, comment on, release or close a GitHub issue. | `pnpm issue-claim check\|claim\|release\|comment <repo>#<n> --by <agent/session>` |
| `issue-triage`, `pr-triage`, `triage-publish` | Reproduce and classify an issue or pull request, then post labels and a comment. | `--data '{"args":"<context>"}'`; `triage-publish` takes `{"phase":"prepare","kind":"issue"}` |
| `review` | Review a working copy or revisions, verify findings and render a walkthrough. | `--data '{"repo":"."}'` |
| `docs-sync` | Regenerate the docs redirect map, or check package tarballs keep their README and `docs/`. | `pnpm docs:sync`, `pnpm docs:check` |
| `create-flow`, `create-skill` | Turn a plain-English request into a working flow or skill. | `--data '{"args":"<request>"}'` |
| `lint` | Lint named files against repository conventions and fix them. | `--data '{"args":"path/a.ts path/b.ts"}'` |
| `release/cut`, `release/rehearsal` | Write a version and changelog, or dry-run the Release workflow. | `--data '{"version":"1.0.0"}'`; `--data '{"tag":"v1.0.0-rc.0"}'` |
| `quality`, `bench/gate`, `security-audit` | Take a quality snapshot, gate scheduler cost, or audit security boundaries. | `pnpm exec smthrs flow start <name> --wait` |

[`@smthrs/coding`](../.smithers/flows/coding/README.md) (private,
`.smithers/flows/coding`) holds the TODO step flows (`Request`, `TodoDelivery`,
`TodoReview`) that a repository `todo` flow builds on. Stack admission starts
`todo`; agents do not start it by hand.

## Apps and other code

Apps are composition roots. They pick a host and use the libraries above.

| App | Path | What it is | Runs on |
| --- | --- | --- | --- |
| [`@smthrs/mvp`](../apps/mvp/AGENTS.md) (private) | `apps/mvp` | The Smithers app, hosted: React over a framework-free Effect state machine, TanStack DB synced by Electric from Neon Postgres, the agent on the browser's durable engine, and Effect-native Workers deployed by Alchemy. | Browser, Cloudflare Worker |
| [`@smithers/site`](../apps/site/docs/UI-DOCS.md) (private) | `apps/site` | The smithers.sh landing page and docs, and in `apps/site/docs-redirect` the Worker that redirects the retired `<slug>.smithers.sh` library docs sites. | Node build, browser, Cloudflare Worker |
| [`smithers-tui`](../apps/tui/README.md) (private) | `apps/tui` | The terminal coding agent over the cell harness. | Bun, Node |
| [`@smthrs/bug-worker`](../apps/bug-worker/README.md) (private) | `apps/bug-worker` | The bug.smithers.sh report intake. | Cloudflare Worker |

Code outside the pnpm workspace:

- `packages/smithers-ffi` is the native C ABI for repository and jj
  operations. `packages/smithers/flows/jj-wasm` compiles the `Jj` operations to
  WebAssembly for the browser.
- `apps/patterns-site` is the static patterns.smithers.sh site.

Opening memory and skill selection uses the `@smthrs/memory` entry above:
`Opening.Sources`, `Opening.layerSources`, and `Opening.select`. Hosts inject
sources and a Jev judge; selection has no filesystem or provider dependency.

The old app (`apps/app`), its edge Worker (`apps/server`), the Go backend
(`packages/backend`, `apps/backend`), its model-host bundle (`apps/model-host`)
and its microVM daemon (`packages/smithers-machined`) were removed on
2026-10-21; read them with `jj file show -r 78407fce59dd <path>`.
