# Engineering rules

Every engineering rule Will gave while building this app, and how each one is enforced. This page is the source the lint rules are generated from: each deterministic rule is an `ImportRules` entry and each judgment rule is a Jev rubric item, and both carry the rule's id from this page. Refresh it at the end of every working session with Will (see [process.rules-become-lint-rules](#processrules-become-lint-rules)).

Times are Pacific (PDT, UTC−7), from the session transcript of 2026-10-19. Quotes are verbatim, typos included.

## How the rules run

| Kind | What it checks | Where it is declared | Run it |
|---|---|---|---|
| `ImportRules` | Imports, imported names and dotted calls, with the TypeScript compiler API. Deterministic. | `apps/mvp/PACKAGE.ts` (`importRules`); SDK-wide rules in each SDK package's `PACKAGE.ts` (`importRules`, from `SdkRules`) | `pnpm exec smithers-build test '//apps/mvp:importRules'`; `smithers-build test` runs every SDK package's |
| Jev rubric | One file at a time: Jev answers one yes-or-no question per rule, and a probability of 0.7 or more is a finding. | `apps/mvp/PACKAGE.ts` (`jevRules`); SDK-wide rules in each SDK package's `PACKAGE.ts` (`jevRules`, from `SdkRules`) | `pnpm exec smithers-build lint '//apps/mvp:jevRules' '//packages/rpc:jevRules'`, one label per package, with `AI_GATEWAY_API_KEY` set, once the build CLI provides `JevReviewLive` (see below) |
| Test | A suite or a configured threshold proves it. | the named test or config | `pnpm test` in the package |
| Process | Not a property of a file: a status claim, a review step, a version-control habit. | this page and `AGENTS.md` | none |

A rule can have more than one kind: an `ImportRules` entry catches the syntax, and a Jev item catches the shapes no syntax rule can name.

`apps/mvp/PACKAGE.test.ts` checks each rule's `files` against the files on disk: a rule that reads a top-level Worker source must read every Worker source in a subdirectory (`worker/github`, `worker/branch`, `worker/flows`), and a rule that reads no tests must read no test support (`worker/test/**`, `worker/<folder>/test/**`). In a glob, `*` and `!(...)` match one path segment and only `**` crosses `/`.

Jev sees one file per request, so a rule that compares files (docs against code, a feature against its e2e test) is not a Jev rule. Those use `ReviewDocsAgainstCode` or are listed as process. Jev reads about 32,000 tokens at once, so a file over 96 KiB is not judged: it gets a `not-judged` warning instead.

Jev findings are `error` unless the rule says advisory. An advisory rule's findings are `warning`: they are reported and never fail the target, because on 2026-10-19 most of their findings were false. Each needs a sharper question before it can gate.

The Jev targets run through `JevLint` in `@smthrs/targets`. The build CLI must provide `JevReviewLive` beside `LlmReviewLive` in `packages/smithers/build/build-cli/src/TargetExecution.ts`; until it does, `smithers-build lint` reports that `smithers-build/jev-review` has no implementation.

The SDK-wide rules cover the packages the app is built on: `@smthrs/model`, `@smthrs/model-host`, `@smthrs/observability`, `@smthrs/platform-cloudflare`, `@smthrs/rpc`, `@smthrs/effect-electric`, `@smthrs/effect-tanstack-db`, `@smthrs/effect-code-storage`, `@smthrs/views`, and `@smthrs/ui`, `@smthrs/repo-view` and `@smthrs/terminal-frame` for root imports, dead code and tests only. The rule text lives once, in `SdkRules` (`packages/repo-targets/src/SdkRules.ts`); each of those packages declares its `importRules` and `jevRules` with it in its own `PACKAGE.ts`, under a role that drops the rules it is exempt from. Widen the list, one `PACKAGE.ts` at a time, once their false-positive rate is known on more code.

## Durable flows

### durable.every-action-is-a-flow

Every action the app or an agent takes, every model call included, runs as a durable `@smthrs/flow` step.

- **Will:** "This is important our entire application will be built on top of durable workflows. We are going to treat every action the agent does as a durable workflow. These workflows run either on the users machine or on cloudflare or on our sandbox provider we are adding. Everything should be durable by default." (18:13). Earlier: "whatever abstraction we have that is doing the model call should be durable by default just like all of smithers because the base layer is durable flows and we build everything else on top of it" (18:12).
- **Scope:** `apps/mvp/worker/**`, tests excluded.
- **Enforced:** `ImportRules` `forbidCalls` `Model.stream` across the app (a model call never leaves the durable layer). Jev for the rest, because "an action outside a flow" has no single syntax.
- **Jev asks:** Does this server code perform a state-changing action, such as a database write, a model call, or a request that changes state in another service, directly in a request handler, cron handler or background callback, instead of as a step of a durable `@smthrs/flow` flow (`Flow.make`, `Action.make`, or an `@smthrs/agent` step)? Read-only queries, read-only proxying and pure helpers are not actions.

### durable.no-hand-rolled-durability

App code never writes its own retries, backoff, timers, sweeps, cron jobs, background jobs, re-dispatch, attempt counters or fencing; the flow engine owns durability.

- **Will:** "There should be no thinking about retries and stuff it should just be built into the durable model. Am I clear and how can we make it so no other agent forgets this" (18:13). "I'll be annoyed we reimplemented durability rather than either 1. using smithers 2. if smithers isn't good enough making smithers good enough" (19:41).
- **Scope:** `apps/mvp/{src,worker,db}/**`, tests and test support excluded.
- **Enforced:** `ImportRules` `forbidCalls` `setTimeout`, `setInterval`, `Effect.retry`, `Effect.repeat`, `Stream.retry`, `Stream.repeat`, `Schedule.*` constructors and `*.waitUntil` on any receiver. Jev for a sweep, an attempt counter or a queue, which are SQL and data shapes, not calls.
- **Jev asks:** Does this file implement its own durability machinery: a retry loop, a backoff schedule, a periodic sweep or cron job, a background job runner, re-dispatch of stuck work, attempt counters, leases or fencing, or a work queue, instead of leaving that to the durable flow engine?

### durable.model-calls-keep-the-cache

A durable model call keeps the provider's prompt cache: a retried or resumed step sends byte-identical requests, and a test proves it.

- **Will:** "Get the model working durably. Make sure we even have a test working that makes sure we are properly using it without breaking the cache." (19:41).
- **Enforced:** test: the durable model step's caching tests (step key stable across processes and key order, one call per sealed step, identical bodies on retry). Process only until those tests exist; a file cannot show it.

### durable.external-writes-once

A step that writes to another service finds its own earlier write only by an identity the step owns: `Action.once` with an adapter keyed by `Action.effectKey`, or a write id chosen and recorded before the write. It never adopts an object because its title, message, name or parent looks like its own, and never searches a time window back from now.

- **Will:** "for that bug you found you should have the agent think hard about durability what is the clean way to use smithers to make issues like that not an issue" (2026-10-21 10:37).
- **Scope:** `apps/mvp/{src,worker,db}/**`, tests excluded.
- **Enforced:** `ImportRules` `forbidCalls` `GitHub.Refs.createBranch`, `GitHub.Commits.createOnBranch`, `GitHub.Commits.getCommit`, `GitHub.Pulls.createPull`, `GitHub.Pulls.findPullByHead`, `GitHub.Pulls.createReview`, `GitHub.Pulls.findReviewByWrite`, `GitHub.Pulls.mergePull`, `GitHub.Issues.createIssue`, `GitHub.Issues.findIssueByWrite`, `GitHub.Issues.createComment` and `GitHub.Issues.findCommentByWrite` across the app: `GitHub.Once` makes those objects. Jev for the shapes no call names: a time window, "the latest", or a state read standing in for identity. Design: [durable external effects](proposals/durable-external-effects.md).
- **Jev asks:** After a write to another service (GitHub, Code Storage, email, a message, a container) may already have happened, does this code decide whether it happened by searching for an object by its title, message, name, parent commit, a time window back from now or "the latest", or by reading back the service's state, instead of calling `Action.once` with an adapter that finds the write by the step's own key?
- **Limit:** an alias (`const { createPull } = GitHub.Pulls`) escapes `forbidCalls`; the Jev item covers it until `ImportRules` checks member access.

### durable.no-substitute-runtime

Never use another durable runtime or agent framework in place of `@smthrs/flow`: no Cloudflare Workflows, Temporal, Inngest, Trigger.dev, the Vercel AI SDK, LangChain or Mastra. A missing host is SDK work.

- **Will:** "that's right why didn't you think of this before? How did you even know what cloudflare workflows is? how can I make it so other agents don't make same mistake" (18:10).
- **Scope:** every source under `apps/` and `packages/`.
- **Enforced:** deterministic, repository-wide, in `packages/repo-targets/contracts/check-dependency-boundaries.mjs` (`pnpm exec smithers-build test //packages/repo-targets:dependencyBoundaries`), so a package without a `PACKAGE.ts` is covered too. Bare `waitUntil` work is caught by [durable.no-hand-rolled-durability](#durableno-hand-rolled-durability).

## SDK first, zero tech debt

### sdk.extend-never-hand-roll

When the app needs something a Smithers package should provide, add it to that package with tests and docs, use it, and delete the app's copy in the same change.

- **Will:** "Please if our existing sdk code is not good enough don't handroll it update the sdk. We are the maintainer of the sdk there is no reason to create tech debt" (15:46). "Do we not have an abstraction in smithers that does this? Smithers is supposed to work as an AI sdk this is the most basic functionality I would expect to exist in an ai sdk" (15:41). "this concept doesn't already exist in smithers?" (14:41).
- **Scope:** `apps/mvp/{src,worker,db}/**`, tests excluded.
- **Enforced:** Jev. Whether code is general infrastructure is a judgment.
- **Jev asks:** Does this app file implement general-purpose infrastructure that any Smithers app would need and that is not specific to this app's product, such as a model client or model configuration type, an HTTP or streaming protocol, a sync or database wrapper, a proxy, a telemetry exporter or relay, or a generic UI component?

### sdk.model-via-smithers

Call models only through `@smthrs/model` and `@smthrs/model-host`, never a provider SDK or raw HTTP.

- **Will:** "We are the maintainers of smithers. We built an agent library and a bunch of agent workflows. And you are using none of them. You are using http request directly to model when we have smithers libraries built for doing this stuff" (14:38).
- **Scope:** all of `apps/mvp`.
- **Enforced:** `ImportRules` `forbid` `openai`, `@anthropic-ai/**`, `@cerebras/**`, `groq-sdk`, `@mistralai/**`, `@google/generative-ai`, `@google/genai`, `ollama`, `cohere-ai`. Raw HTTP is caught by [effect.native-api-first](#effectnative-api-first).

### sdk.library-catalog-first

Before choosing any library, find the job in [`docs/libraries.md`](../../../docs/libraries.md) and name the entry used in the change.

- **Will:** "you should understand the use case for every smithers library and have it in Agent md and claude md" (14:39).
- **Enforced:** process only. The rule governs a choice and a change description, not a file's contents; the root `AGENTS.md` and `docs/libraries.md` state it.

### sdk.no-dead-code

No dead code, no duplicate implementations, no unused exports, and no SDK module without a consumer.

- **Will:** "FOr the sdk module nothing uses, we have no tolerance for tech debt or dead code. Are we not using it because we built it and then forgot to use it? Whatever the reason is fix it." (19:41).
- **Scope:** all sources in `apps/mvp`, tests included; SDK-wide through `SdkRules`.
- **Enforced:** Jev, advisory, for what one file shows: commented-out code, unreachable branches, unused locals, stubs and in-file duplicates. An export nothing imports is a whole-repository fact one file cannot show; that needs a deterministic unused-export check, not yet built.
- **Jev asks:** Treat every export as used: other files may import it. Does this file contain dead or duplicate code: commented-out code, an unreachable branch, a local declaration or parameter the file never uses, a placeholder or TODO stub, or a second implementation of logic the same file already has?

### sdk.root-imports-only

Import every package from its root entry. If something should be public, export it from the root.

- **Will:** "I don't like that we are doing deep imports import only from the root if something is not public that should be public make it public" (14:42).
- **Scope:** all of `apps/mvp`; SDK-wide.
- **Enforced:** `ImportRules` `rootImportsOnly` `@smthrs/*` in `apps/mvp/PACKAGE.ts`, and in every SDK package's `src/` and `examples/` through `SdkRules`. Two packages declare known deep imports: `@smthrs/model-host` reads the command catalog from `@smthrs/cli/Catalog` and `@smthrs/cli/CatalogRequest`, because the `@smthrs/cli` root carries the whole CLI; `@smthrs/rpc` imports `@smthrs/canonical/Record` and `@smthrs/canonical/Serializer`, because its contracts stay runtime-free and the `@smthrs/canonical` root loads Effect.
- **No `@smthrs/ui` subpath.** The heavy renderers are packages of their own, imported from their roots: `RepoView`, `CodeFileView`, `PierreDiffView` and `MarkdownEditor` (Shiki and Milkdown) are `@smthrs/repo-view`, and `TerminalFrame` is `@smthrs/terminal-frame`. Will chose that over an `@smthrs/ui/adapters/*` exception on 2026-10-20: "Yes move code viewer to it's own package" (decision [0006](decisions/0006-repo-clone-and-view.md) question 2).
- **No exceptions.** The agent evals read the host's judge from the `@smthrs/cli` root (`NodeControl.layerSeatEvaluator`), as `apps/tui` does ([agent evals](features/agent-evals.md#the-judge)).

### sdk.platform-neutral

Host-specific code (Node and Bun modules, the DOM, processes, sockets, the filesystem) lives only in the platform host packages and is injected. Every other package runs in a browser, a Worker, Node and Bun.

- **Will:** "Our architecture for our backend libraries should be there should be a host like package that gets dependency injected depending on the host and the packages outside of that should work on all platforms that's a bug in o0ur packagess if it doesn'tt work that way" (14:44). "Well beyond the rule that's how it should already work there is likely a bug if it doesn't work that way already" (14:46).
- **Scope:** every SDK package's `src/` except `@smthrs/platform-*` and `@smthrs/ui`, which renders to the DOM; the browser half of the app, `apps/mvp/src/**`.
- **Enforced:**
  - Test: `packages/repo-targets/browser/browser-contract.mjs` bundles each browser-safe root for the browser and fails on a Node or Bun import.
  - `ImportRules` `forbid` `node:*`, `bun:*` and bare Node built-ins in the app's browser sources.
  - `ImportRules` `forbid` the same modules in every platform-neutral SDK package's `src/`, through `SdkRules`.
  - Jev, SDK-wide, for the globals the bundle check documents it cannot see (`process`, `Buffer`, `__dirname`, `require`).
- **Jev asks (SDK):** Does this library module use a host-specific API, such as `process`, `Buffer`, `__dirname`, `require`, `node:` or `bun:` modules, the DOM, child processes or the filesystem, instead of receiving it as an injected service?

### sdk.component-library

Components, colors and the theme come from `@smthrs/ui`. A reusable piece goes into that library; the app's CSS holds only page layout.

- **Will:** "Why is there so much css in this app? We should be using things from our component library. Move stuff to component library properly or justify why it's here" (13:34).
- **Scope:** `apps/mvp/src/**/*.{tsx,css}`.
- **Enforced:** Jev.
- **Jev asks:** Does this file define reusable visual design, such as colors, typography, buttons, inputs, cards, shadows or a generic component, that belongs in the `@smthrs/ui` component library, rather than only this screen's layout (placement, grid, spacing)?

### sdk.generic-libraries

A library is generic: no app's names, tables, routes, copy or defaults, so another app can use it.

- **Will:** "Yes at the very end we will be moving it into it's own reusable package others can use so it should be generic and architected well" (19:59).
- **Scope:** the SDK packages meant for any app: `@smthrs/model`, `@smthrs/observability`, `@smthrs/platform-cloudflare`, `@smthrs/effect-electric`, `@smthrs/effect-tanstack-db`, `@smthrs/effect-code-storage` and `@smthrs/views` (the `library` and `host` roles of `SdkRules`). `@smthrs/rpc` and `@smthrs/model-host` hold the Smithers app's own contracts and host, so they are out of scope.
- **Enforced:** Jev.
- **Jev asks:** Does this library module contain names, tables, routes, copy or defaults specific to one app, such as `messages`, `chat`, `ChatApi` or `smithers.sh`, that make it unusable by other apps?

### sdk.pnpm-workspace

Workspace packages depend on each other through pnpm `workspace:` specifiers, never `file:` or `link:` paths.

- **Will:** "are you using file links instead of pnpm wtf is that?" (14:43), "we are in a pnpm workspace" (14:43).
- **Enforced:** not yet. It is a `package.json` property, which `ImportRules` does not read. It belongs in the repository-wide dependency gate (`check-dependency-boundaries.mjs`) as a `file:`/`link:` specifier check.

## Effect

### effect.boundary-only

Run an Effect only at the program's boundary: in the browser, `start` in `src/boot.ts`, which `src/main.tsx` calls once; on the backend, Alchemy's Effect-native Workers run the handlers and the app never calls `runPromise`, `runFork` or `runSync`. A synchronous bridge exists only where a caller must have the result before it returns.

- **Will:** "This is breaking another rule which is we should never runPromise or any other way of breaking out of effect and if we do it should only be on the absolute boundary of the program where necessary" (14:48). "In the cloudflare alchemy cae it's not clear to me we should ever runPromise on backend" (14:49).
- **Scope:** `apps/mvp/{src,worker,db}/**` except `src/main.tsx` and tests (a test is its own boundary); SDK-wide.
- **Enforced:** `ImportRules` `forbidCalls` `Effect.runPromise`, `Effect.runPromiseExit`, `Effect.runSync`, `Effect.runSyncExit`, `Effect.runFork`, `Effect.runCallback` in the app, and `*.runPromise` and the rest on any receiver in every SDK package's `src/` except `@smthrs/ui`, through `SdkRules`. Jev for runtime methods and bridges, and for whether a bridge is necessary.
- **Settled (2026-10-20, [rulings](rulings.md) SDK-7):** Will's narrow "where necessary" governs: a listener whose events could be a `Stream` has no need to bridge. `apps/mvp/AGENTS.md` now says the same; it used to allow every callback a layer registers to bridge.
- **Jev asks (app):** A DOM listener that must call `preventDefault` before it returns, and a function a React event handler calls to dispatch an action, may run an Effect synchronously. Apart from those, does this file run an Effect, with `Effect.runPromise`, `runSync`, `runFork` or `runCallback`, their `...With` forms, a `ManagedRuntime` or `Runtime`'s run methods, or a helper that turns an Effect into a Promise or a callback, for example in a listener whose events could be a `Stream`?
- **Jev asks (SDK):** Does this library module run an Effect, with `Effect.runPromise`, `runSync`, `runFork` or `runCallback`, their `...With` forms, or a `ManagedRuntime` or `Runtime`'s run methods, instead of returning Effects for the program's boundary to run? A callback a third-party library calls, which must return a Promise or a value, may bridge.

### flows.local-first-placement

A flow runs locally (in the browser, later the native app) unless it needs something the local host doesn't have: a key the person must not hold, a machine to run code on, or something that must happen while every device is off. How long it takes never decides.

- **Will:** "Long work isn't what decides if it's remote or not. We prefer things to be local first actaully" and "The agent should run on frontend and the frontend itself should be durable" (2026-10-19, night). Decision [0011](decisions/0011-the-agent-runs-in-the-browser.md).
- **Scope:** every flow `apps/mvp` defines or starts.
- **Enforced:** Jev.
- **Jev asks:** Does this code run a flow on a remote host (Cloudflare or a sandbox) without needing a server-held key, a machine to run code on, or to run while every device is off, or justify remote placement by how long the work takes?

### sdk.host-agnostic-flows

The agent and every flow are host-agnostic Effect programs. Cloudflare (or any host) reaches them only as injected layers, so the same code runs on Cloudflare, locally in the native app, or in a sandbox.

- **Will:** "make sure our cloudflare code is decoupled from cloudflare via dependency injection because our native app version later will just run the cloudflare code locally" (2026-10-19, night).
- **Scope:** all of `apps/mvp` except the Worker entries (`worker/ChatApi.ts` with `worker/ChatApiProgram.ts`, the program it imports when the Worker first builds it, `worker/DevChatApi.ts` for `alchemy dev`, `worker/index.ts`, `worker/Executions.ts` with `worker/ExecutionHost.ts`, which host remote flows, `worker/BranchSandboxes.ts`, which hosts the branches' machines, and `worker/BranchRooms.ts`, which hosts their rooms), `alchemy.run.ts` and `infra/**`, which wire the Cloudflare layers.
- **Enforced:** `ImportRules` `forbid` `alchemy`, `alchemy/**`, `cloudflare:*`, `@cloudflare/**` and `@smthrs/platform-cloudflare` outside those files. A test runs each flow on a non-Cloudflare host. Jev for Cloudflare-only assumptions, such as a `Request` shape or `env` binding, reaching flow code. `worker/flows/Pause.test.ts` runs `probe/Pause` on the Node host, and `worker/ExecutionHost.workerd.test.ts` runs it in local workerd ([remote flows](features/remote-flows.md)).
- **Jev asks:** Does this flow or app module assume it runs on Cloudflare, for example by reading a Worker `env` binding, a Durable Object, `ExecutionContext` or a Cloudflare-only API, instead of receiving that capability as an injected Effect service?

### effect.wrap-every-library

Use every third-party library through Effect: its own Effect API when it has one, else a thin Effect wrapper written first. App code calls the wrapper, never the raw library.

- **Will:** "Any public apis we use in app wrap it in a effect.ts wrapper so as fast as possible we are using effect" (16:28).
- **Scope:** all of `apps/mvp`; SDK-wide, except `@smthrs/ui`, whose React components render third-party views.
- **Will, on Code Storage:** "make sure you don't use code storage apis without first wrapping it in effect" (2026-10-19, night).
- **Enforced:** `ImportRules` `forbid` `@tanstack/db`, `@tanstack/electric-db-collection`, `@electric-sql/**` and `@pierre/storage`: the app reaches them only through `@smthrs/effect-tanstack-db`, `@smthrs/effect-electric` and `@smthrs/effect-code-storage`, which calls Code Storage's HTTP API through Effect `HttpClient`. Raw `fetch` is banned by `effect.native-api-first`. Jev for any other library.
- **Jev asks (app):** Does this file call a third-party library's Promise, callback or class API directly in app logic, instead of through that library's own Effect API or an Effect wrapper?
- **Jev asks (SDK):** Does this library module expose a third-party library's Promise, callback or class API to its callers, or call it in its own logic, instead of wrapping it in Effect?

### effect.native-api-first

When a library has an Effect API, use it rather than wrapping its plain API: Effect `HttpClient` for HTTP, `@effect/sql-pg` for Postgres, Effect `Config` for configuration.

- **Will:** "Does livestore not export an effect api? If it does use that stop using the nromal api" (15:15). "are you sure this is effect native? I'm seeing us wrap store.commit in effect I thought this was effect native" (15:15).
- **Scope:** all of `apps/mvp`; `fetch` calls in non-test sources except `src/main.tsx`, where the boundary hands the browser's `fetch` to Effect's `FetchHttpClient`.
- **Enforced:** `ImportRules` `forbidCalls` `fetch`, `globalThis.fetch`, `window.fetch`, `self.fetch`, and `forbid` `axios`, `node-fetch`, `ky`, `got`, `undici`, `pg`, `postgres`, `@neondatabase/serverless`, `drizzle-orm`, `kysely`, `@prisma/client`. The Jev item of [effect.wrap-every-library](#effectwrap-every-library) covers the rest.

### effect.backend-is-effect

The backend is Effect: Effect's HTTP server, Schema and Config on Alchemy's Effect-native Workers. No Hono, Express or other server framework.

- **Will:** "Is the backend using hono?" (14:18), "Ok is it using effect.ts" (14:19), "I still want effect.ts only especially for backend" (16:28).
- **Scope:** all of `apps/mvp`.
- **Enforced:** `ImportRules` `forbid` `hono`, `hono/**`, `express`, `fastify`, `koa`, `itty-router`, `h3`, `elysia`.

### effect.choices-are-services

Choices such as the model, provider, URLs and limits are services provided by layers, or Effect `Config` with a named default; never constants in a handler. Everything that should be configurable is configurable.

- **Will:** "What model we are using I would expect to be a service it's the cannonical example of something that should be a service and I suspect the way smithers packages work already supports this" (15:06). "Make sure everything that should be configurable is in fact configurable like model we are using cerebras url etc." (14:34).
- **Scope:** `apps/mvp/{src,worker}/**` non-test, and `alchemy.run.ts`.
- **Enforced:** Jev.
- **Jev asks:** Does this file hard-code a deployment choice, such as which model or provider to use, a service URL, a limit, a timeout or a credential name, inside a handler or module body, instead of reading it from a service provided by a layer or from Effect `Config` with a named default?

### effect.config-at-build

Worker request handlers and durable flow steps consume configuration captured when Alchemy builds the program. They never evaluate Effect Config against the runtime host, including through a deferred Effect, Layer or helper.

- **Will:** Production CI follow-up, 2026-10-23: read `REPO_FLOWS_REPOSITORIES` beside `REPO_FLOWS` at program build, inject the set, and catch runtime Config reads as a class after the `SUMMARY_MODEL` defect.
- **Scope:** all `worker/**/*.ts`, excluding tests and test support.
- **Enforced:** `tests/worker-config.test.ts`, run by `pnpm test`: TypeScript source/type analysis of request handlers, step factories, flow bodies and runtime callbacks, following worker-owned deferred dependencies. Fixtures prove Config aliases, imports and lazy layers fail while values already yielded during build pass. The check failed on both original Dispatch reads before the fix.
- **Limit:** reflects the worker's current authoring patterns; dynamic dispatch and erased types still require review. See [decision 0088](decisions/0088-worker-config-at-build.md).

## Frontend and state

### ui.react-is-only-the-view

The app's state and behavior live in a framework-free Effect state machine that the TUI and other frontends can reuse; React only reads live queries and dispatches actions.

- **Will:** "I want the app itself to function independent of the state machine and the state machine to be testable and usable outside the context of react. In fact I want to later reuse this state machine in the tui and other frontends." (14:14). "Yes remember the rule that the app business logic should work outside of react and reacts hould simply be the view layer on top of what is otherwise purely effect.ts using tanstack db in a flux like pattern?" (20:02).
- **Scope:** `apps/mvp/src/**`.
- **Enforced:** `ImportRules` `forbid` `react`, `react-dom` and `@tanstack/react-db` in non-`.tsx` sources. Jev for logic inside components.
- **Jev asks:** Does this React file hold business logic, such as computing, filtering, validating or transforming data, calling an API, managing timers or subscriptions, or deciding what happens next, instead of only reading live queries or the router, rendering, and dispatching actions?

### ui.view-and-logic-in-separate-files

UI and logic may share a folder, never a file. A `.tsx` file never imports Effect or the state machine's libraries.

- **Will:** "It's fine to colocate react ui with business logic for the same ui as long as they are not in the same file but I don't mind them being in the same folder" (20:06). "For rules like don't use effect in tsx it would be great if we did a PACKAGE.ts style lint rule for all of them" (20:07).
- **Scope:** `apps/mvp/src/**/*.tsx`.
- **Enforced:** `ImportRules` `forbid` `effect` and `effect/**` in `.tsx`, and `forbid` `@smthrs/effect-tanstack-db`, `@smthrs/effect-electric`, `@smthrs/model`, `@smthrs/model-host`, `@effect/**`, `@tanstack/db`, `@electric-sql/**` in `.tsx`.

### ui.no-usestate-useeffect

No `useState`, and no `useEffect` for data or state syncing.

- **Will:** "The code is shit it has a useEffect in it." (13:30). "I see a useState which may be justified but I asked for us to use flux with tanstack db as state management." (14:12).
- **Scope:** `apps/mvp/src/**/*.tsx`.
- **Enforced:** `ImportRules` `forbidNames` `useState`, `useEffect` from `react` (named imports and `React.useState` reads alike).

### ui.flux-state

State is flux: route state lives in the URL through TanStack Router, and all other state, a tab's UI state included, lives in TanStack DB collections.

- **Will:** "use tanstack router too please and all state should be in tanstack db. State management should be flux with all state either living in the route or tanstack db ideally with exception being like state required just to get ui element to work like whether a menu is open or not" (13:32).
- **Scope:** `apps/mvp/src/**`.
- **Enforced:** `ImportRules` `forbidNames` `useReducer`, `useLayoutEffect`, `useInsertionEffect`, `useSyncExternalStore` from `react` in `.tsx`, and `forbid` other stores (`zustand`, `jotai`, `redux`, `@reduxjs/**`, `react-redux`, `mobx`, `mobx-react`, `mobx-react-lite`, `valtio`, `recoil`, `xstate`, `@xstate/**`, `@tanstack/react-query`, `@tanstack/query-core`, `swr`). Jev for module-level stores and refs used as state.
- **Jev asks:** Does this file keep application or UI state, meaning values that change as a person uses the app, outside the URL route and TanStack DB collections, for example in React state hooks, refs used as a store, module-level variables that are reassigned, or a hand-written store or event emitter? Constants, configuration, a DOM root, a runtime and a scope are not state.

### data.device-schemas-versioned

Every collection a device keeps and every outbox payload declares its versions; a stored row's schema changes only with a new version, and data only the device has changes only with a migration to it.

- **Will:** "when we deploy to prod we will have a frontend migration to do and in fact need a generalized way of handling migrations of our local first data that should be robust and make messing up hard" (2026-10-20, about 20:05, Telegram).
- **Scope:** `apps/mvp/src/**`.
- **Enforced:** test: `src/device/schemas.test.ts` checks `src/device/registry.ts` against `src/device/schemas.lock.json` (`Migrations.check`); the app's `Persistence` refuses a persisted collection the registry doesn't declare at that version (`Migrations.Undeclared`); `Migrations.local` and `Migrations.payload` refuse a version without a migration as the module loads. Decision [0021](decisions/0021-local-first-migrations.md).

### ui.tanstack-router

Routing is TanStack Router, declared in `src/router.tsx`. Never hand-roll routing.

- **Will:** "yea you rolled your own router please don't do that" (13:33).
- **Scope:** `apps/mvp/src/**`.
- **Enforced:** `ImportRules` `forbid` `react-router`, `react-router-dom`, `wouter`, `@reach/router`, `next/router`, `next/navigation`; `forbidCalls` `history.pushState`, `history.replaceState`, `location.assign`, `location.replace` and their `window.` forms. Jev for path matching by hand.
- **Jev asks:** Does this file route by hand: reading or writing `window.location` or `history`, matching URL paths, or switching screens on the URL, instead of declaring routes and navigating with TanStack Router?

### ui.minimal-text

Cards, panes and toasts carry the fewest words needed to act: no explanatory prose, no provenance footers, no "not measured yet" rows, no sentence beside a button.

- **Will (root `AGENTS.md`, 2026-09-15):** "Cards, panes, toasts, and lessons carry the fewest words needed to act. No explanatory prose about how the product works, no provenance footers, no rows whose value is "not measured yet", no summary sentence beside a button."
- **Scope:** `apps/mvp/src/**/*.tsx`.
- **Enforced:** Jev.
- **Jev asks:** Does this component show a person text they do not need in order to act, such as an explanation of how the product works, a provenance footer, a row whose value is "not measured yet", or a sentence beside a button that repeats what the button does?

### arch.one-responsibility

Code is structured to scale: one folder per screen and per feature, and each file has one responsibility.

- **Will:** "It's poorly structured to scale with a bunch of code in files it shouldn't belong improve the code quality" (13:30). "it is again not built to scale and has way too much stuff in AppShell" (14:12).
- **Scope:** `apps/mvp/{src,worker}/**` non-test.
- **Enforced:** Jev.
- **Jev asks:** Does this file mix unrelated responsibilities that belong in separate files or folders, such as a screen's layout together with feature logic and shared helpers, or several features in one module, so that it will not scale as features are added?

## Plugins

### plugin.core-names-no-plugin

The core names each built-in plugin in its registry: `src/plugins/builtin.ts` for UI, `src/plugins/builtinFlows.ts` for flow source. Deleting a plugin's folder and its registry line removes the feature. The flow registry is server-safe and imports no browser UI.

- **Will:** "It's very important that we similar to webpack try to treat everything like a plugin." (2026-10-20 14:40, PLUGIN-1).
- **Scope:** every core source in `apps/mvp` (`src/`, `worker/`), only those two registry entries left out.
- **Enforced:** `ImportRules` `forbid` of `**/plugins/*/src/**` and `**/plugins/*/plugin.json` in `apps/mvp/PACKAGE.ts` (decision [0017](decisions/0017-everything-is-a-plugin.md), "The deletion test").

### plugin.public-interface-only

A compiled plugin imports only `@smthrs/*` roots, `react`, `@tanstack/react-db`, `effect` and its own folder. First-party plugins get no private interface; if one needs something, the public interface gains it.

- **Will:** "The smitehrs UI should have it's core infrastructure and features but as many features as we support as possible should just be opinionated plugins we made using the same plugin interface anybody can use" (2026-10-20 14:40, PLUGIN-1).
- **Scope:** `apps/mvp/plugins/*/src/**`.
- **Enforced:** `ImportRules` `forbid` in `apps/mvp/PACKAGE.ts`: any other package, and any relative path that leaves the plugin's folder. This is hygiene, not containment: compiled code runs with the app's full power (decision 0017, "Compiled code is trusted application code").

## Configuration

### config.generic-names

A setting is named for what it is, not for one vendor: an OpenAI-compatible URL is not `CEREBRAS_URL`. A credential only one vendor issues may carry its name.

- **Will:** "ANd make it as generic as it shoudl be. So if cerebrase url is simply an openai compatible api name it something more generic than cerebras" (14:34).
- **Scope:** `apps/mvp/{src,worker,db}/**` non-test, `alchemy.run.ts`, `playwright.config.ts`.
- **Enforced:** Jev. `ImportRules` sees callees, not the key a `Config` call reads.
- **Jev asks:** Does this file name a configuration setting, such as an environment variable, `Config` key, option or type, after one vendor when the setting is generic, for example `CEREBRAS_URL` for any OpenAI-compatible endpoint, or a `CerebrasConfig` type for any model?

## Observability

### obs.every-action-observed

Every action logs, traces and counts, in the browser and on the backend, with tests and docs. Log lines carry the span's `trace_id` and `span_id`. Usage metrics show how people use the app.

- **Will:** "We have 0 observability. 0 logging. This is a production system. We need to have perfct observability and logging this should even be tested and documented as we add it." (15:14). "great observability of frontend and backend and metrics so we can see how user is using app" (15:17).
- **Scope:** `apps/mvp/worker/**`, `apps/mvp/src/features/**`, `apps/mvp/src/*.ts`, tests excluded.
- **Enforced:** test: [observability.md](observability.md) lists every record and the tests that assert them; that is where "logs, traces and counts" is held. Jev, advisory, for an action with no record at all.
- **Jev asks:** Does this file define an action, such as a request handler, a database write, a model call, a background program, or what happens when a person does something, that records none of a structured log line, a span or a metric for it? A function that only dispatches another action, binds a key or an event to an action, forwards a request, or is a query or helper whose caller records the work, is not an action.

### obs.content-free

No message content, prompt, provider error text or credential appears in any log line, span attribute, span event, span exception or metric attribute.

- **Will (`/Users/williamcory/AGENTS.md`, 2026-10-13):** "Keep credentials and customer payloads out of diagnostic output."
- **Scope:** `apps/mvp/{src,worker}/**` non-test; SDK-wide, except `@smthrs/ui`.
- **Enforced:** test: the sentinel test asks a question containing a sentinel string and fails if it reaches exported telemetry. Jev per file.
- **Jev asks (app):** Does any log line, span attribute, span event, error message, error cause or metric attribute in this file carry user content or secrets, such as message text, a question, an answer, a prompt, a provider's error text or a credential, instead of only ids, counts, durations, sizes, status codes and error codes?
- **Jev asks (SDK):** Does this module record user content or secrets, such as message text, a prompt, a model's output, a provider's error text or a credential, in a log line, a span attribute, a span event, a span's failure, or a metric attribute? Text returned to a caller or shown in a UI is not recorded. A span opened with `SpanFailure.fn` records no failure text, and a value passed through redaction before it is recorded is not content.

### obs.agent-debuggable-dependencies

A dependency an agent cannot debug from its records is not used: errors must surface, and traffic must be readable and replayable.

- **Will:** "Ok let's kill livestore hard to debug for an agent is unacceptable." (16:25).
- **Enforced:** process only. It governs choosing a library ([decision 0001](decisions/0001-electric-postgres-tanstack-db.md)); see [stack.postgres-electric-tanstack-db](#stackpostgres-electric-tanstack-db) for the deterministic part.

## Tests

### test.e2e-defines-working

A feature works only when a real e2e test passes against it, and is broken when one fails. When something is broken and no test fails, write the failing e2e test first.

- **Will:** "If something is broken by definition it being broken is having an e2e test failing. If something is working by definition it means there should be an e2e passing" (12:11). "Ok so not having a failing e2e test is absolutely unacceptable." (12:10).
- **Enforced:** process only. It defines what a status claim means; a file cannot show it.

### test.e2e-local-and-live

Every feature has e2e tests that run locally and against a live deployment.

- **Will:** "we should have e2e tests for all features capable of running in production and locally and we should have the ability to produce a gif of the feature working" (13:43).
- **Scope:** `apps/mvp/playwright.config.ts`, `apps/mvp/e2e/**`.
- **Enforced:** Jev for e2e code tied to one environment. That every feature has a test is a cross-file fact: process, until a check pairs `docs/features/*.md` with e2e specs.
- **Jev asks:** Is this end-to-end code tied to one environment, such as a hard-coded localhost URL or port, local-only file paths, or a dev-only fixture, so the tests cannot run against a live deployment?

### test.e2e-declared-needs

Every e2e test runs against every target or declares, with `requires(...)` from `e2e/target.ts`, the need its target lacks; it skips there with that need's reason. A test known to fail on a target is marked `broken(...)`. Nothing else skips, and only `e2e/target.ts` tells a local target from a deployment.

- **Will:** "All tests should run in multiple modes. So we should be able to run them locally against a dev server or against the production deployment" (2026-10-19 12:26). "ANything that is known to be broken should have a broken test marked as broken committed in the repo" (12:26).
- **Scope:** `apps/mvp/e2e/**`.
- **Enforced:** `e2e/target.test.ts` scans the specs for `test.skip(`, a localhost check and `E2E_SESSION_COOKIE`. The deployment run's summary (`e2e/summary.ts`) fails on a skip that names no declared need. A helper that needs a dev build or local people throws `UndeclaredNeed` where its need is unmet.

### test.gif-per-flow

Every e2e test records video, so every user flow has a GIF on request (`pnpm e2e:gifs`).

- **Will:** "If I ask for a gif of the feature you should be able to deliver me the gif associated with that feature or user flow right away no issues" (12:11).
- **Scope:** `apps/mvp/playwright.config.ts`.
- **Enforced:** Jev on the config.
- **Jev asks:** Does this Playwright configuration fail to record a video of every test, for example video off, `retain-on-failure` or `on-first-retry` instead of `on`?

### test.no-mocks-in-e2e

E2E tests run the real app, Worker, Postgres, Electric and model: no route mocks, no fake backends. Any other mock stays only if Will accepts a written justification; request interception never does, because faults are injected as services (`test.faults-by-injection`).

- **Will:** "A mocked e2e test should be deleted if we have any e2e tests mocking either justify to me why the mock is actually a good idea, delete the tests, or fix the test to not mocking" (12:11).
- **Scope:** `apps/mvp/e2e/**`.
- **Enforced:** `ImportRules` `forbidCalls` `*.route`, `*.routeFromHAR`, `*.routeWebSocket`: a call to any of those members on any receiver, such as `page.route`, `tab.page.route` or `page.context().route`. No exceptions: an outage is simulated by injection (`test.faults-by-injection`), never by intercepting requests.

### test.faults-by-injection

Unhappy paths (a sync service that is down, a refused write, a slow model) are tested by dependency injection only.
- Each external dependency is an Effect service: the sync service, ChatApi's client and the model.
- A test provides a faulty implementation of that service; it never intercepts requests or mocks modules.
- Happy-path tests always use the real service. That's why a fault service is allowed: the real one is proven elsewhere.

- **Will:** "Please only do this via dependency injection. So the sync service itself should be a service and we should be able to make a test service. It is ok in this case because our happy path tests use a real service and we are testing unhappy paths and we can note that in the rule" (2026-10-19, evening).
- **Enforced:** `test.no-mocks-in-e2e`'s `forbidCalls` (no request interception), plus Jev: "Does this test simulate a failure some way other than providing a test implementation of an Effect service, or does a happy-path test use a test service instead of the real one?"

### test.no-mocks-of-our-code

Tests never mock our own code. Unit tests run against the real compose Postgres and Electric; only the model provider is a scripted seam, and faults come from test implementations of Effect services (`test.faults-by-injection`).

- **Will:** "Also why the fuck are we mocking?" (12:10).
- **Scope:** `apps/mvp/**/*.test.ts`, `apps/mvp/e2e/**`, `apps/mvp/src/test/**`, `apps/mvp/worker/**/test/**`, `apps/mvp/db/TestDatabase.ts`.
- **Enforced:** `ImportRules` `forbidCalls` `vi.mock`, `vi.doMock`, `vi.stubGlobal`, `jest.mock`. Jev for fake servers and fake implementations.
- **Jev asks:** Does this file replace our own code or infrastructure, such as a Smithers package, ChatApi, the app's modules, Postgres or Electric, with a mock, stub, fake server, fake implementation or spy, instead of running the real thing? Scripting the model provider, standing in for Cloudflare's platform bindings, and providing a faulty test implementation of an Effect service for an unhappy path are allowed.

### test.behavioral

Tests are behavioral and can fail: no tautologies, no assertions that echo constants, no fixed sleeps (use `TestClock` or wait on a condition).

- **Will:** "Also clearly your testing was not sufficient I found a bug immediately" (13:59). "We need e2e tests to be thorough unit tests to be thorough good architecture" (15:17).
- **Scope:** `apps/mvp/**/*.test.ts`, `apps/mvp/e2e/**/*.spec.ts`; SDK-wide test files.
- **Enforced:** `ImportRules` `forbidCalls` `setTimeout` and `*.waitForTimeout` (any receiver) in `*.test.ts` and `e2e/**`. `//packages/smithers/control:importRules` also guards the cancellation, channel, client and observing-executor regression files against fixed waits and mocks, and all control sources against host imports and Effect execution boundaries. Jev for the rest.
- **Harness memory tests:** `packages/smithers/agent/harness:importRules` also forbids `*.sleep` in the memory admission, QuickJS sandbox and persistent-realm suites; they use conditions or `TestClock`.
- **Jev asks:** Does this test file contain a test that cannot fail or does not test behavior: an assertion that only echoes a constant or the test's own setup, a tautology, a test with no meaningful assertion, a fixed sleep instead of waiting on a condition or `TestClock`, or a check that code was called rather than what it did?

### test.skip-only-when-absent

A test skips only when a service it needs is genuinely absent, and says so; any other setup error fails it.

- **Source:** `RULES.md` 5 (the lead's brief for this push, 2026-10-19), from the final Codex and Fable reviews. No direct quote from Will.
- **Scope:** `apps/mvp/**/*.test.ts`, `apps/mvp/e2e/**`.
- **Enforced:** Jev.
- **Jev asks:** Does this test file skip tests on an error other than a required service being unreachable, or skip without saying which service is missing, or swallow a setup or migration failure?

### test.coverage-100

Every package and app touched keeps 100% statement, branch, function and line coverage, set as thresholds in its vitest config.

- **Will:** "Note this is our final draft of this code so I expect absolute perfection wrt test coverage everything" (19:41).
- **Scope:** `apps/mvp/vitest.config.ts` and each touched package's vitest config.
- **Enforced:** test: vitest `coverage.thresholds` at 100 fails the suite when coverage drops. `apps/mvp/vitest.config.ts` sets them over its `coverage.include` list: every `src/**/*.ts` but tests, test support and the engine worker's entry, and the listed `worker/` and `db/` files.

### test.local-first-multidevice

The local-first behavior is tested end to end on several devices: two browsers, reloads mid-answer, offline, late joiners.

- **Will:** "We should have a test testing the local first nature of it on multidevice as well" (15:17).
- **Enforced:** process only. It requires a suite to exist (`apps/mvp/e2e/local-first.spec.ts`); no single file shows that it is complete.

### perf.benchmarks-local-and-live

Performance benchmarks run locally and against a live deployment, compared with a baseline (`pnpm bench`).

- **Will:** "We should also have performance benchmarks that can be run locally and also on live." (15:17).
- **Enforced:** process only. A suite-level requirement; [benchmarks.md](benchmarks.md) is the contract.

## Docs

### docs.feature-docs-first

Every feature is documented in the app's internal docs, written first: documentation-driven development.

- **Will:** "Remember our standing rules that all features should be documented in internal docs somewhere we should do documentaiton driven development" (13:43). "Can we document this in the mvp internal docs" (14:14).
- **Enforced:** process only, until a check pairs each `src/features/<name>/` with `docs/features/<name>.md`. That is a cross-file check.

### docs.exact

Every doc matches the code. Whoever makes a doc wrong fixes it in the same change.

- **Source:** `RULES.md` 8 (lead, 2026-10-19), from Will's documentation-driven rule above.
- **Scope:** `apps/mvp/docs/**`, `apps/mvp/AGENTS.md`.
- **Enforced:** `ReviewDocsAgainstCode` (an `LlmLint` model review) in `apps/mvp/PACKAGE.ts`, because comparing a doc with code reads several files at once and Jev sees one.

## GitHub

### github.no-actions

Smithers has no view of and no support for GitHub Actions: no workflows, workflow runs, check runs, check suites or commit statuses. Smithers flows take their place, and a pull request's Checks tab lists the Smithers flow runs on its head SHA ([0012](decisions/0012-git-end-to-end.md) decision 12). One write is allowed: each Smithers check reports its own result on the commit it ran on as the GitHub status `smithers/<name>`, write-only, through `GitHub.Statuses.create`, so branch protection can require it (ruling GH-10, [pulls](features/pulls.md#commit-statuses)). Smithers never reads a status back.

- **Will:** "Githubactions we don't support those at all we should not have any view or support for github actions. We support smithers workflows however which are very similar but run on our servers" (2026-10-20). GH-10 (queue, 2026-10-20 23:37): Smithers writes `smithers/<flow>` commit statuses, write-only.
- **Scope:** `apps/mvp/{src,worker,db}/**`, tests and test support excluded. The app's own `/$owner/$repo/actions` route lists Smithers flow runs ([0014](decisions/0014-flows-authoring-debugging-and-home-view.md)); it is not GitHub Actions.
- **Enforced:** Jev, plus a test. `ImportRules` reads imports and calls, not the strings an API path or a webhook event is written in, so it can't ban them. `apps/mvp/PACKAGE.test.ts` fails when a file the Jev rule reads names a GitHub `/repos/…/actions/` path, `check-runs`, `check-suites`, `/statuses/`, a commit's `/status`, a `check_run` or `workflow_run` event, or the SDK's `CheckRun` step. The one allowed write goes through the SDK's `GitHub.Statuses.create`, so the app never names the path.
- **Jev asks:** Does this file read, write, subscribe to, store or show GitHub Actions, check runs, check suites or commit statuses: a GitHub API path under `/actions/`, `check-runs`, `check-suites` or `statuses`, a `check_run`, `check_suite`, `status`, `workflow_run` or `workflow_job` webhook event, `@smthrs/integrations`' `GitHub.Actions.CheckRun`, or a table or view of them? `GitHub.Actions` in `@smthrs/integrations` is that SDK's module of integration steps, not GitHub Actions, and the app's own `/$owner/$repo/actions` route lists Smithers flow runs; neither is a finding by itself. One write is allowed (GH-10): reporting a Smithers check's own result on a commit with `GitHub.Statuses.create`, as the context `smithers/<name>`; reading any status back is still a finding.

## Infrastructure, dependencies and auth

### infra.iac-everything

All infrastructure is code, Postgres included, and every piece of it deploys.

- **Will:** "Do we have infra as code for everything including postgres?" (17:31). "yup that solution is correct make sure all our infra as code is deployable" (17:37).
- **Enforced:** process only. Deployability is proven by a deploy, not by a file; `alchemy.run.ts` and [infrastructure.md](infrastructure.md) are the code and the contract.

### stack.postgres-electric-tanstack-db

Shared state is Postgres, synced by Electric into TanStack DB. LiveStore is gone.

- **Will:** "Switch to using electric sql with a postgres db please we have used electric sql in past o I'm familiar with it and iwwe should go back to tanstack db." (16:28).
- **Scope:** all of `apps/mvp`.
- **Enforced:** `ImportRules` `forbid` `@livestore/*` and `@livestore/**`.

### stack.alchemy-for-cloudflare

Alchemy deploys and runs everything on Cloudflare, from `alchemy.run.ts`. No Wrangler configuration.

- **Will:** "Ok let's use alchemy for cloudflare effect.ts for everything" (14:26).
- **Enforced:** process only. The rule is about a configuration file's absence, which `ImportRules` cannot see.

### deps.seven-day-rule

Every new dependency version is at least 7 days old. Will lifted this for the app's stack on 2026-10-19.

- **Will:** "Yes use latest version of all of these libraries please as an exception right now permission to have everything on bleeding edge latest" (14:29).
- **Enforced:** config, once `pnpm-workspace.yaml` sets `minimumReleaseAge`; today it sets only the `minimumReleaseAgeExclude` list, so nothing enforces the age. Will's exception is recorded here so the list is not read as a bypass.

### auth.open-but-bounded

Signed-out use is intended: add no sign-in gates; auth is designed later, once, for every feature, client and host ([todo.md](todo.md)). Every network input is still bounded: size limits, parameter allowlists, length and count limits.

- **Will:** "we also should support unauthenticated users using the app. We want unauthenticated users to be able to ask questions and use our app freely for now we will just have alerts set up if we notice a lot of token spend happening" and "we really want to architecture our auth a bit later with high level of intention so it works for everything (please mark this down)" (19:41).
- **Revised (Will, 2026-10-19, decision [0008](decisions/0008-auth.md) §11):** signed-out people can't ask Smithers. The model endpoint refuses a call with no actor through the injected `Sessions` service (`worker/Actor.ts`), which production provides as signed out until sign-in lands. That service is the seam sign-in plugs into, not a one-off check; reading and the rest stay open.
- **Scope:** `apps/mvp/worker/**` non-test.
- **Enforced:** Jev.
- **Jev asks:** Does this server code accept input from the network without bounding it, such as no body size limit, no allowlist of forwarded parameters, or no length or count limits, or does it add a one-off sign-in, token or IP check of its own? A file that only forwards requests to a handler that bounds them is compliant.

## Process

### process.rules-become-lint-rules

Every engineering rule Will gives becomes an enforced lint rule in the package's `PACKAGE.ts` (`ImportRules` or a Jev rubric), catalogued on this page. At the end of each session with Will, re-read his messages and refresh both.

- **Will:** "For rules like don't use effect in tsx it would be great if we did a PACKAGE.ts style lint rule for all of them" (20:07). "we have access to jev too so we can to intelligence based rules you should have a subagent read this chat history and put everything relavent into a lint rule we can update those lint rules again at end of chat" (20:07).
- **How to refresh:** extract only Will's typed messages from the session transcript (type `user` with `origin.kind` `human`, plus mid-turn `queued_command` attachments), add new rules here with their quotes, then add the matching `ImportRules` entries and Jev items with the same ids.
- **Enforced:** process only.

### process.reuse-proven-code

Port what already worked: copy the minimal proven code and reproduce existing designs exactly.

- **Will:** "We already had this working on old app so you should be able to copy that code but only copy over the minimal code to get this working along with e2e tests." (13:43). "When i ask you to implement a feature we already implemented it should take you like 60 seconds max cmon" (13:47).
- **Enforced:** process only.

### process.go-fast

Iterate fast: quality comes from quick iterations with Will's feedback, not from long silent work.

- **Will:** "the slower you go the less iterations we get going fast is important for quality we get quality from you goiong fast and me providing feedback you spinning wheels for 10 minutes helps nobody" (13:48).
- **Enforced:** process only.

### process.reviews-alongside

`/codex` (Sol) reviews work in progress at checkpoints. When work is done, `/codex astra` reviews it first, the lead responds to and fixes its findings, and then a Fable subagent reviews the result. Reviews never block Will's own review.

- **Will:** "have /codex review our code so far and also have a fable subagent review it. Wait til you are done to dispatch fable have codex do it both now and later" (14:54). "Reviews aren't blocking to me reviewing it I just want agents reviewing with me." (16:11). "remember to have /codex astra review code and then once responding to it's reviews have fable review" (2026-10-20, 01:08).
- **Enforced:** process only.

### process.works-or-doesnt

A feature works or doesn't; never "partly". Answer status questions with a passing or failing e2e test behind the word.

- **Will:** "Also in future never say partly again. It either works or doesn't work. Partly is just a silly way of saying no." (12:09).
- **Enforced:** process only. It governs status reports; [test.e2e-defines-working](#teste2e-defines-working) is the evidence behind the word.

### process.github-is-home

All work lives on GitHub, pushed and deployed: no local backups of repositories, no long-lived branches beside `main`.

- **Will:** "Push to github you silly" (10:47), "i want everygthing pushed to github deployed and ready to go was I not clear?" (10:48), "is there no standing rule that talks about how we avoid branches?" (13:08).
- **Enforced:** process only.

### process.jj-only

Version control is jj; never the git CLI.

- **Will (`/Users/williamcory/AGENTS.md`, 2026-10-05):** "Use Jujutsu (`jj`) for every repository version-control operation".
- **Enforced:** process only.

## worker.request-owned-io

Worker requests own their I/O. A module or service layer must never retain an
in-flight lookup for another request to await (2026-10-25 About incident).
`eslint.worker-inflight.js`, run by `pnpm lint:worker-io`, rejects Effect
`Cache.make/makeWith`, `Deferred.make/makeUnsafe`,
`Effect.cached/cachedWithTTL/cachedInvalidateWithTTL`, `ScopedCache.make/makeWith`,
`RcMap.make`, `RcRef.make` and `Pool.make/makeWithTTL/makeWithStrategy` in production Worker sources. It
resolves import aliases, forward-declared local aliases, assignment and
destructuring aliases, including pipe-form calls. Factory
functions are checked too: a function can be called once during layer construction.
This deliberately conservative rule does not attempt whole-program reachability.
The sole memoization allowlist is `Effect.cached(Effect.succeed(<literal constant>))`;
arrays and objects must contain only literal constants. Schema declarations,
constants, persisted `DurableDeferred` tokens and storage-backed caches are safe
and outside the ban. Tests and test hosts are excluded. Raw promises and arbitrary
user-written sharing still require review; this is a guard against known Effect
primitives, not a proof of every request's ownership.

The other two current hits, `github/RepoRoles.ts` and `github/Compare.ts`, now
create each request's signer independently. No other current calls to the guarded
constructors occur in production Worker sources. Importing a signer's WebCrypto key is
asynchronous; a cached signer initialization was not safe to share.
`worker/RepoAbout.workerd.test.ts` exercises thirty concurrent cold reads through
the real bundled RepoApi route, real Postgres and GitHub in workerd. Each must
return 200 with the repository's name; Node cannot reproduce this ownership fault.
