# apps/mvp

The Smithers app, hosted only, built from scratch one feature at a time (Will, 2026-10-19; SCOPE-1, SCOPE-8). Work lands on `main` before Will reviews it, and he reviews every feature (HOST-3). [The rulings](docs/rulings.md) are the source of truth. It is the base every later feature builds on, so each feature lands with its architecture, tests, observability, benchmarks and docs, never "later".

## Use the Smithers SDK; extend it, never hand-roll

- When the app needs something a Smithers package should provide, add it to that package with tests and docs, then use it here. We maintain the SDK. A local copy in the app is tech debt.
- Examples: model calls and streaming (`@smthrs/model`); the configured model as a service (`HostModel` in `@smthrs/model-host`); UI components (`@smthrs/ui`).
- Read [docs/libraries.md](../../docs/libraries.md) before writing app code.
- Import packages from their root only.

## Durable flows

Every action, every model call included, is a durable Smithers flow step; see the root [AGENTS.md](../../AGENTS.md#everything-is-a-durable-flow-will-2026-10-19-permanent). The app writes no retry loops, background jobs or sweeps of its own.

## Effect

- Run an Effect only at the program's boundary. In the browser that is `start` (`src/boot.ts`), which `main.tsx` calls once. Elsewhere, bridge with the services captured there (`Effect.runPromiseWith`, `Effect.runSyncWith`) only where necessary: a DOM listener that must call `preventDefault` before it returns, a React event handler that dispatches an action, or a third-party callback that must return a Promise or a value. A listener whose events could be a `Stream` is a `Stream` (SDK-7, rule [`effect.boundary-only`](docs/rules.md#effectboundary-only)). On the backend, Alchemy's Effect-native Workers run the handlers, so the app never calls `runPromise`, `runFork` or `runSync` there.
- Use every library through Effect: a library's own Effect API when it has one (Effect `HttpClient`, `Config`, `@effect/sql-pg`), else an SDK wrapper: TanStack DB through `@smthrs/effect-tanstack-db`, Electric through `@smthrs/effect-electric`. App code calls the wrappers, never the raw library.
- Choices such as the model are services provided by layers, never constants in a handler.

## State (flux)

Read [docs/state.md](docs/state.md) first: the state machine is framework-free TypeScript that the web app, and later the TUI, adapt to.

- Route state lives in the URL, through TanStack Router (`src/router.tsx`). Never hand-roll routing.
- Shared state lives in Postgres. Electric syncs it into TanStack DB collections that the device keeps (SQLite on OPFS), and every write goes through a durable outbox to ChatApi (decision 0002). One tab's UI state lives in local-only TanStack DB collections. Components read through live queries and write through actions. See [docs/decisions/0001-electric-postgres-tanstack-db.md](docs/decisions/0001-electric-postgres-tanstack-db.md).
- No `useState`: even UI state, such as whether the composer is open or its draft, is a local-only collection.
- Every collection kept on the device and every outbox payload is declared in `src/device/registry.ts` (decision 0021). Changing a stored row's schema needs a new version, and for a local store or payload a migration; `src/device/schemas.test.ts` fails otherwise.
- No `useEffect` for data or state syncing.
- A feature's logic and its React views share its folder, never a file: no `.tsx` file imports `effect` or our Effect libraries, and no logic file imports `react` or `@tanstack/react-db`.

## Structure

- `src/screens/<screen>/`: one folder per route screen. It composes feature components; its stylesheet holds page layout only.
- `src/features/<feature>/`: one folder per feature, laid out as in [docs/state.md](docs/state.md).
- `worker/`: Cloudflare Workers, deployed and run locally by Alchemy (`alchemy.run.ts`). No Wrangler config.
  - `ChatApi.ts` is Effect-native: it stores questions in Postgres, proxies Electric shapes, serves the metered model endpoint (`POST /api/model/<role>`, [docs/features/model-endpoint.md](docs/features/model-endpoint.md)) and the answer routes the browser's agent answers through ([docs/features/agent.md](docs/features/agent.md)), keeps the conversation's views (`POST /api/views`, [docs/features/web-pages.md](docs/features/web-pages.md)) and renders the agent's generated views in its presentation realm (`worker/ViewRealm.ts`, [docs/features/views.md](docs/features/views.md)), keeps the agent's status and the person's answers to its questions (`/api/runs`, [docs/features/agent-status.md](docs/features/agent-status.md)), keeps each person's feed and what they follow (`/api/watches`, `/api/notifications/ack`, [docs/features/notifications.md](docs/features/notifications.md)), syncs model spend alerts to Admins (`/api/shapes/spend-alerts`, [docs/features/spend-alerts.md](docs/features/spend-alerts.md)), starts remote flows on the `FlowExecution` Durable Object ([docs/features/remote-flows.md](docs/features/remote-flows.md)), routes repositories to `RepoApi.ts` (cloning and reading at a commit, [docs/features/repo.md](docs/features/repo.md)), routes a repository's docs to `docs/Api.ts` ([docs/features/docs.md](docs/features/docs.md)), routes GitHub's webhook, git writes and the issues' shapes to `github/Api.ts` ([docs/features/issues.md](docs/features/issues.md)), routes changes to a repository's stack and the TODOs' shapes to `stack/Api.ts` ([docs/features/todos.md](docs/features/todos.md)), serves a TODO's run and a repository's to watch from the engine's schema and stops a repository's through `RemoteRuns.ts` ([docs/features/runs.md](docs/features/runs.md#a-run-on-cloudflare)), and routes repository secrets' writes and names shape to `secrets/Api.ts` ([docs/features/secrets.md](docs/features/secrets.md)). It never answers a question itself.
  - `SignIn.ts` is sign-in: the GitHub App's routes under `/api/auth/*` and the `Sessions` layer every route reads who is asking from ([docs/features/sign-in.md](docs/features/sign-in.md)).
  - `DevChatApi.ts` is ChatApi under `alchemy dev`, with real sign-in when the GitHub App is configured and a local developer signed in otherwise; a deploy never bundles it.
  - `index.ts` forwards `/api/*` and serves the app.
  - `Executions.ts` (the Alchemy Durable Object) and `ExecutionHost.ts` run remote flows, one Durable Object per execution; `flows/` holds those flows, which never import Cloudflare ([docs/features/remote-flows.md](docs/features/remote-flows.md)).
  - `branch/` holds the branch workspace's routes (tracking a branch, sharing it, its room, its terminals, its sandbox tools in `branch/SandboxCalls.ts`) and the one access policy they share (`branch/Access.ts`); `BranchSandboxes.ts` the branches' machines: one `SandboxObject` Durable Object and container per branch, the forge proxy its box clones through, and its tools, sleep and wake (`branch/Machine.ts`, [docs/features/sandbox-tools.md](docs/features/sandbox-tools.md)); `BranchRooms.ts` their rooms, one hibernating `RoomObject` per branch for presence ([docs/features/branch-workspace.md](docs/features/branch-workspace.md)).
  - `stack/` holds the stack's one writer (`Stack.ts`: the only code that writes a repository's TODOs, one transaction on its `stacks` row per change) and its route and shapes (`Api.ts`, `POST /api/repos/<owner>/<name>/stack`) ([docs/features/todos.md](docs/features/todos.md)).
  - `domains/` holds custom domains: the routes and shape (`Api.ts`), `domain/Verify` and `domain/Remove` (`DomainFlows.ts`), and the `DomainProvider` service with its Cloudflare for SaaS and DNS adapters, the only code that reaches a domain provider ([docs/features/domains.md](docs/features/domains.md)).
  - `personal/` holds a person's own model: its routes and shape (`Api.ts`), `model/Put` and `model/Delete` (`ModelFlows.ts`), `PersonalModels`, which opens a person's model for one call (`Models.ts`), and their ledger (`Usage.ts`) ([docs/features/personal-model.md](docs/features/personal-model.md)).
  - `secrets/` holds repository secrets: the write routes and names shape (`Api.ts`), `secret/Put` and `secret/Delete`, SECRETS_KEY's keys, and a branch box's egress (`SandboxEgress.ts`), over `@smthrs/secrets` ([docs/features/secrets.md](docs/features/secrets.md)).
- `db/`: the Postgres schema as Effect SQL migrations (`db/migrations`, `pnpm db:migrate`) and the client layer ChatApi, the migrations and the tests share. `docker-compose.yml` runs Postgres and Electric locally (`pnpm db:up`). Infrastructure: [docs/infrastructure.md](docs/infrastructure.md).
- Configurable values (model, API URL, keys) come from the environment through Effect `Config`, named for what they are, not for one vendor.
- Components, colors and the theme come from `@smthrs/ui` (`packages/smithers/ui`). A reusable piece the app needs goes into that library, with its test and docs, not into this app.
- `src/styles/fonts.css`: loads the Inter files the theme names.

## Tests, observability, performance

- **Unit (`pnpm test`):** every action, query, wrapper and handler, in Node. ChatApi's handlers run against the real compose Postgres; the model is the only scripted seam.
- **End to end (`pnpm e2e`):**
  - A feature works only if a real test passes against it: no route mocks or fake backends.
  - Cover multiple devices, offline use and reloads, because the app is local-first.
  - Each test records video and saves the browser's console on failure. `pnpm e2e:gifs` turns the last run's recordings into each flow's video (`~/Desktop/smithers-mvp/videos/<spec>/<test>.mp4`) and GIF preview, and fails on a GIF with blank, frozen or flashing frames (`pnpm e2e:gifs:check`). Each video opens on a 2 s title card: the feature (the describe blocks, else the spec's name), the test's name (its title up to the colon) and one line saying what it proves (a `summary` annotation, `test("title", { annotation: { type: "summary", description: "…" } }, …)`, else the title after the colon). Every page and device is a 1280×800 window recorded 1:1, never zoomed or cropped, and about half the tests run in dark mode, chosen per test by a hash of its spec and title (a test that needs a mode sets `{ type: "theme", description: "light" }`). Waits play fast, and a caption names each step in product words, never a URL or an id. `<test>.chapters.json` is `{ title, feature, name, line, status, theme, chapters }`: `status` is the run's (`passed`, `failed`, …), `theme` its mode and `chapters` the timeline from its `test.step`s and actions. Wrap a helper's user-visible action in `test.step` to name its chapter.
- **Observability:** every feature logs, traces and counts what it does, front end and back end, with tests and docs. Logs never carry message content or credentials.
- **Benchmarks (`pnpm bench`):** run locally and against a live deployment, compared with a baseline.
- **Agent evals (`pnpm eval`):** the real agent against the real model through the metered endpoint, scored by checks, a zero-tolerance safety gate and the host's judge, and compared with a committed baseline ([docs/features/agent-evals.md](docs/features/agent-evals.md)). They spend tokens, so `pnpm test` runs only their unit tests.
