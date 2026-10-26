/**
 * Targets for the MVP app: the engineering rules in apps/mvp/docs/rules.md, enforced.
 *
 * `importRules` holds the rules a parser can check; append one there and the
 * `importRules` target checks it. Run it with
 * `pnpm exec smithers-build test '//apps/mvp:importRules'`.
 *
 * `jevRules` holds the rules that need judgment; Jev answers one question per
 * rule about one file at a time. Run it with `AI_GATEWAY_API_KEY` set:
 * `pnpm exec smithers-build lint '//apps/mvp:jevRules'`.
 *
 * Every rule carries its id from apps/mvp/docs/rules.md, which quotes Will.
 *
 * @since 1.0.0
 */
import type { ImportRule, JevRule } from "@smthrs/repo-targets"
import { ImportRules, JevRules, ReviewDocsAgainstCode } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "apps/mvp"

/**
 * Server code: every Worker source at any depth (worker/github, worker/branch, worker/flows), tests and test support
 * (worker/test/ and a folder's own test/) left out. `!(*.test)` and `!(test)` each match one path segment, so the
 * three globs cover the top level, one folder down, and every depth below a folder that is not test support.
 * PACKAGE.test.ts fails if a Worker source escapes them.
 */
const workerSources = [
  "worker/!(*.test).ts",
  "worker/!(test)/!(*.test).ts",
  "worker/!(test)/!(test)/**/!(*.test).ts"
]

/** The built-in plugins' sources (decision 0017, `apps/mvp/plugins/<id>/src`), tests left out. */
function pluginSources() {
  return ["plugins/*/src/**/!(*.test).ts", "plugins/*/src/**/*.tsx"]
}

/**
 * The core's sources that may not name a plugin: every app source but the built-in UI and flow registries.
 * Each plugin is named in its registry only (decision 0017, "The deletion test").
 */
const coreSources = [
  "src/!(test|plugins)/**/!(*.test).ts",
  "src/!(*.test).ts",
  "src/plugins/!(builtin|builtinFlows|*.test).ts",
  "src/plugins/*/**/!(*.test).ts",
  "src/**/!(main).tsx",
  "src/main.tsx",
  ...workerSources
]

/**
 * The app's own sources, tests and test support left out: the browser state machine and components, the Worker
 * and the database code. `src/main.tsx` is left out too: it calls the browser's one Effect boundary and hands it
 * the page's host capabilities.
 */
const appSources = [
  "src/!(test)/**/!(*.test).ts",
  "src/!(*.test).ts",
  "src/**/!(main).tsx",
  ...pluginSources(),
  ...workerSources,
  "db/Database.ts",
  "db/migrations/*.ts"
]

/**
 * Every import rule the app holds its sources to, in report order. Exported for PACKAGE.test.ts, which checks what
 * each rule's `files` read.
 */
export const importRules: ReadonlyArray<ImportRule> = [
  {
    kind: "forbid",
    files: coreSources,
    modules: ["**/plugins/*/src", "**/plugins/*/src/**", "**/plugins/*/plugin.json"],
    because: "plugin.core-names-no-plugin: the core names a built-in plugin only in src/plugins/builtin.ts (UI) or builtinFlows.ts (flows), so " +
      "deleting the plugin's folder and its registry line removes the feature. See \"Everything is a plugin\" in the " +
      "root AGENTS.md and apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    files: pluginSources(),
    modules: [
      "@tanstack/!(react-db)",
      "@tanstack/!(react-db)/**",
      "!(@smthrs|@tanstack|react|effect|.|..)",
      "!(@smthrs|@tanstack|react|effect|.|..)/**"
    ],
    because: "plugin.public-interface-only: a compiled plugin imports only @smthrs/* roots, react, " +
      "@tanstack/react-db, effect and its own folder; anything else it needs, the public interface gains. See " +
      "\"Everything is a plugin\" in the root AGENTS.md and apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    files: ["plugins/*/src/*.{ts,tsx}"],
    modules: ["../../**"],
    because: "plugin.public-interface-only: a compiled plugin reaches nothing outside its own folder. See " +
      "apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    files: ["plugins/*/src/*/**/*.{ts,tsx}"],
    modules: ["../../../**"],
    because: "plugin.public-interface-only: a compiled plugin reaches nothing outside its own folder. See " +
      "apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    files: ["src/**/*.tsx", "plugins/*/src/**/*.tsx"],
    modules: ["effect", "effect/**"],
    because: "A component renders state and dispatches actions; the framework-free state machine runs Effect. " +
      "See \"Effect\" and \"State (flux)\" in apps/mvp/AGENTS.md."
  },
  {
    kind: "forbid",
    files: ["src/**/*.{ts,mts,cts,js,mjs,cjs}"],
    modules: ["react", "react/**", "@tanstack/react-db", "@tanstack/react-db/**"],
    because: "The state machine is framework-free TypeScript that the web app and the TUI adapt to; React lives " +
      "only in .tsx components. See \"State (flux)\" in apps/mvp/AGENTS.md and apps/mvp/docs/state.md."
  },
  {
    kind: "forbidNames",
    files: ["src/**/*.tsx", "plugins/*/src/**/*.tsx"],
    modules: ["react"],
    names: ["useState", "useEffect"],
    because: "UI state is a local-only TanStack DB collection read through live queries, never useState or " +
      "useEffect. See \"State (flux)\" in apps/mvp/AGENTS.md."
  },
  {
    kind: "rootImportsOnly",
    packages: ["@smthrs/*"],
    because: "Import Smithers packages from their root entry only. See \"Use the Smithers SDK; extend it, never " +
      "hand-roll\" in apps/mvp/AGENTS.md and \"Use the Smithers libraries\" in the root AGENTS.md."
  },
  {
    kind: "forbidCalls",
    callees: ["Model.stream"],
    because: "Every model call is a durable flow step through @smthrs/agent or @smthrs/flow, never a direct " +
      "Model.stream. See \"Everything is a durable flow\" in the root AGENTS.md and \"Durable flows\" in " +
      "apps/mvp/AGENTS.md."
  },
  // The rules below carry their id from apps/mvp/docs/rules.md, which quotes Will for each one.
  {
    kind: "forbidCalls",
    files: appSources,
    callees: [
      "Effect.runPromise",
      "Effect.runPromiseExit",
      "Effect.runSync",
      "Effect.runSyncExit",
      "Effect.runFork",
      "Effect.runCallback"
    ],
    because: "effect.boundary-only: run an Effect only at the program boundary: in the browser, start in " +
      "src/boot.ts, which src/main.tsx calls once; on the backend, Alchemy runs the Worker's handlers. See " +
      "apps/mvp/docs/rules.md."
  },
  {
    kind: "forbidCalls",
    files: [...appSources, "src/main.tsx"],
    callees: [
      "setTimeout",
      "setInterval",
      "Effect.retry",
      "Effect.repeat",
      "Stream.retry",
      "Stream.repeat",
      "Schedule.exponential",
      "Schedule.spaced",
      "Schedule.fixed",
      "Schedule.recurs",
      "Schedule.fibonacci",
      "*.waitUntil"
    ],
    because: "durable.no-hand-rolled-durability: retries, schedules, timers and background work come from the " +
      "@smthrs/flow engine, never app code. See \"Everything is a durable flow\" in the root AGENTS.md and " +
      "apps/mvp/docs/rules.md."
  },
  {
    kind: "forbidCalls",
    files: appSources,
    callees: [
      "GitHub.Refs.createBranch",
      "GitHub.Commits.createOnBranch",
      "GitHub.Commits.getCommit",
      "GitHub.Pulls.createPull",
      "GitHub.Pulls.findPullByHead",
      "GitHub.Pulls.createReview",
      "GitHub.Pulls.findReviewByWrite",
      "GitHub.Pulls.mergePull",
      "GitHub.Issues.createIssue",
      "GitHub.Issues.findIssueByWrite",
      "GitHub.Issues.createComment",
      "GitHub.Issues.findCommentByWrite"
    ],
    because: "durable.external-writes-once: a branch, commit, pull request, review, merge, issue or comment a step " +
      "makes goes through Action.once with a GitHub.Once adapter, which keys it by the step and finds it by that key; " +
      "never adopt one because its name, message or parent looks like yours. See apps/mvp/docs/rules.md and " +
      "apps/mvp/docs/proposals/durable-external-effects.md."
  },
  {
    kind: "forbid",
    modules: [
      "openai",
      "openai/**",
      "@anthropic-ai/**",
      "@cerebras/**",
      "groq-sdk",
      "@mistralai/**",
      "@google/generative-ai",
      "@google/genai",
      "ollama",
      "cohere-ai"
    ],
    because: "sdk.model-via-smithers: call models through @smthrs/model and @smthrs/model-host inside a flow " +
      "step, never a provider SDK. See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbidCalls",
    // The two program boundaries are left out: src/main.tsx hands the browser's fetch to Effect's FetchHttpClient, and
    // the engine worker's entry (src/flows/engine.worker.ts) fetches the SQLite build it hands BrowserRuntime.run.
    files: appSources.map((glob) =>
      glob === "src/!(test)/**/!(*.test).ts" ? "src/!(test)/**/!(*.test|*.worker).ts" : glob
    ),
    callees: ["fetch", "globalThis.fetch", "window.fetch", "self.fetch"],
    because: "effect.native-api-first: make HTTP requests with Effect HttpClient, not fetch. See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    modules: [
      "axios",
      "node-fetch",
      "ky",
      "got",
      "undici",
      "pg",
      "postgres",
      "@neondatabase/serverless",
      "drizzle-orm",
      "drizzle-orm/**",
      "kysely",
      "@prisma/client"
    ],
    because: "effect.native-api-first: use the library's own Effect API, Effect HttpClient for HTTP and " +
      "@effect/sql-pg for Postgres. See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    modules: ["hono", "hono/**", "express", "fastify", "koa", "itty-router", "h3", "elysia"],
    because: "effect.backend-is-effect: the backend is Effect's HTTP server, Schema and Config on Alchemy's " +
      "Effect-native Workers. See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    files: [
      "src/**",
      "db/**",
      "worker/!(ChatApi|ChatApiProgram|DevChatApi|index|Executions|ExecutionHost|BranchSandboxes|BranchRooms).ts",
      "worker/*/**",
      "e2e/**",
      "bench/**"
    ],
    modules: ["alchemy", "alchemy/**", "cloudflare:*", "@cloudflare/**", "@smthrs/platform-cloudflare"],
    because: "sdk.host-agnostic-flows: the agent and every flow run on Cloudflare, in the native app or in a sandbox, " +
      "so Cloudflare reaches them only as injected layers wired in the Worker entries (worker/ChatApi.ts with the program it imports, worker/ChatApiProgram.ts, " +
      "worker/DevChatApi.ts, worker/index.ts, worker/Executions.ts with worker/ExecutionHost.ts for remote flows, and " +
      "worker/BranchSandboxes.ts for the branches' machines and worker/BranchRooms.ts for their rooms), " +
      "alchemy.run.ts and " +
      "infra/. See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    modules: [
      "@tanstack/db",
      "@tanstack/electric-db-collection",
      "@electric-sql/client",
      "@electric-sql/**",
      "@pierre/storage",
      "@pierre/storage/**"
    ],
    because: "effect.wrap-every-library: reach TanStack DB, Electric and Code Storage only through " +
      "@smthrs/effect-tanstack-db, @smthrs/effect-electric and @smthrs/effect-code-storage. See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    modules: ["@livestore/*", "@livestore/**"],
    because: "stack.postgres-electric-tanstack-db: LiveStore was dropped because an agent could not debug it " +
      "(docs/decisions/0001). See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbidNames",
    files: ["src/**/*.tsx"],
    modules: ["react"],
    names: ["useReducer", "useLayoutEffect", "useInsertionEffect", "useSyncExternalStore"],
    because: "ui.flux-state: state lives in the route or in TanStack DB collections, never in React. See " +
      "\"State (flux)\" in apps/mvp/AGENTS.md and apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    modules: [
      "zustand",
      "zustand/**",
      "jotai",
      "jotai/**",
      "redux",
      "@reduxjs/**",
      "react-redux",
      "mobx",
      "mobx-react",
      "mobx-react-lite",
      "valtio",
      "valtio/**",
      "recoil",
      "xstate",
      "@xstate/**",
      "@tanstack/react-query",
      "@tanstack/query-core",
      "swr"
    ],
    because: "ui.flux-state: state lives in the route or in TanStack DB collections; no other store. See " +
      "apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    modules: ["react-router", "react-router-dom", "wouter", "@reach/router", "next/router", "next/navigation"],
    because: "ui.tanstack-router: routing is TanStack Router, in src/router.tsx. See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbidCalls",
    files: ["src/**"],
    callees: [
      "history.pushState",
      "history.replaceState",
      "window.history.pushState",
      "window.history.replaceState",
      "location.assign",
      "location.replace",
      "window.location.assign",
      "window.location.replace"
    ],
    because: "ui.tanstack-router: never route by hand; navigate through TanStack Router. See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    files: ["src/**/*.tsx"],
    modules: [
      "@smthrs/effect-tanstack-db",
      "@smthrs/effect-electric",
      "@smthrs/model",
      "@smthrs/model-host",
      "@effect/**",
      "@tanstack/db",
      "@electric-sql/**"
    ],
    because: "ui.view-and-logic-in-separate-files: a component reads live queries and dispatches actions; the " +
      "state machine's libraries stay out of .tsx. See apps/mvp/docs/state.md and apps/mvp/docs/rules.md."
  },
  {
    kind: "forbid",
    files: ["src/!(test)/**/!(*.test).ts", "src/!(*.test).ts", "src/**/*.tsx"],
    modules: [
      "node:*",
      "node:*/**",
      "bun:*",
      "fs",
      "fs/**",
      "path",
      "crypto",
      "os",
      "child_process",
      "net",
      "http",
      "https",
      "stream",
      "url",
      "util",
      "events",
      "buffer"
    ],
    because: "sdk.platform-neutral: the browser app reaches no Node or Bun module; host code lives in platform " +
      "host packages and is injected. See \"Platform rule\" in docs/libraries.md and apps/mvp/docs/rules.md."
  },
  {
    kind: "forbidCalls",
    files: ["e2e/**"],
    // Any receiver: tab.page.route, page.context().route and page?.route all fail.
    callees: ["*.route", "*.routeFromHAR", "*.routeWebSocket"],
    because: "test.no-mocks-in-e2e: an e2e test runs the real app, Worker, Postgres, Electric and model, and never " +
      "intercepts a request; an outage is a faulty Effect service the test opens the app on (e2e/faults.ts, " +
      "test.faults-by-injection). No exceptions. See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbidCalls",
    files: ["**/*.test.ts", "src/test/**", "worker/**/test/**", "db/TestDatabase.ts"],
    callees: ["vi.mock", "vi.doMock", "vi.stubGlobal", "jest.mock"],
    because: "test.no-mocks-of-our-code: tests run our real code; only the model provider is a scripted seam. " +
      "See apps/mvp/docs/rules.md."
  },
  {
    kind: "forbidCalls",
    files: ["**/*.test.ts", "e2e/**"],
    callees: ["setTimeout", "*.waitForTimeout"],
    because: "test.behavioral: wait on a condition or TestClock, never a fixed sleep. See apps/mvp/docs/rules.md."
  }
]

/**
 * Fails when a source in the app breaks one of {@link importRules}.
 *
 * @since 1.0.0
 * @category test
 */
const importRulesTarget = ImportRules({ cwd, rules: importRules })

/** Browser code: the state machine and components, tests and test support left out. */
const browserSources = ["src/!(test)/**/!(*.test).ts", "src/!(*.test).ts", "src/**/*.tsx"]

/** Every test and its support code. */
const testSources = ["**/*.test.ts", "e2e/**/*.ts", "src/test/**/*.ts", "worker/**/test/**/*.ts", "db/TestDatabase.ts"]

/**
 * The judgment rules: Jev answers one yes-or-no question per rule about one file at a time. Each id, question and
 * pair of criteria is the rule's entry in apps/mvp/docs/rules.md; change both together. Exported for PACKAGE.test.ts.
 */
export const jevRules: ReadonlyArray<JevRule> = [
  {
    id: "durable.every-action-is-a-flow",
    files: workerSources,
    lookFor: "Does this server code perform a state-changing action, such as a database write, a model call, or a " +
      "request that changes state in another service, directly in a request handler, cron handler or background " +
      "callback, instead of as a step of a durable @smthrs/flow flow (Flow.make, Action.make, or an @smthrs/agent " +
      "step)? Read-only queries, read-only proxying and pure helpers are not actions.",
    violation: "A state-changing action runs outside a durable flow step.",
    compliant: "Every state-changing action runs as a flow step, or the file performs none (read-only queries or " +
      "proxying, pure helpers, schemas, wiring)."
  },
  {
    id: "durable.no-hand-rolled-durability",
    files: [...workerSources, "src/!(test)/**/!(*.test).ts", "src/!(*.test).ts", "db/Database.ts", "db/migrations/*.ts"],
    lookFor: "Does this file implement its own durability machinery: a retry loop, a backoff schedule, a periodic " +
      "sweep or cron job, a background job runner, re-dispatch of stuck work, attempt counters, leases or fencing, " +
      "or a work queue, instead of leaving that to the durable flow engine?",
    violation: "The file hand-rolls retries, backoff, sweeps, cron, background jobs, re-dispatch, attempt counting, " +
      "fencing or a work queue.",
    compliant: "The file has none of that machinery; at most it calls a library or flow step that provides it, or " +
      "sets one deadline on one request."
  },
  {
    id: "durable.external-writes-once",
    files: workerSources,
    lookFor: "After a write to another service (GitHub, Code Storage, email, a message, a container) may already " +
      "have happened, does this code decide whether it happened by searching for an object by its title, message, " +
      "name, parent commit, a time window back from now or 'the latest', or by reading back the service's state, " +
      "instead of calling Action.once with an adapter that finds the write by the step's own key?",
    violation: "A step recognizes its own earlier write by what it looks like or when it happened, so it can adopt " +
      "someone else's object or miss its own and write twice.",
    compliant: "Every write that may repeat goes through Action.once, or looks itself up only by an identity chosen " +
      "and recorded before the write (a write id stored with the request), across the whole listing; or the file " +
      "makes no such write."
  },
  {
    id: "flows.local-first-placement",
    files: [...workerSources, ...browserSources],
    lookFor: "Does this code run a flow on a remote host (Cloudflare or a sandbox) without needing a server-held " +
      "key, a machine to run code on, or to run while every device is off, or justify remote placement by how long " +
      "the work takes?",
    violation: "A flow runs remotely that could run locally; placement follows duration instead of need.",
    compliant: "Flows run locally unless they need a server-held key, a machine for code, or to run while every " +
      "device is off."
  },
  {
    id: "sdk.host-agnostic-flows",
    files: [...workerSources, ...browserSources],
    lookFor: "Does this flow or app module assume it runs on Cloudflare, for example by reading a Worker env " +
      "binding, a Durable Object, ExecutionContext or a Cloudflare-only API, instead of receiving that capability " +
      "as an injected Effect service? The Worker entries worker/ChatApi.ts, worker/index.ts, worker/Executions.ts, " +
      "worker/ExecutionHost.ts, worker/BranchSandboxes.ts and worker/BranchRooms.ts wire those layers and are exempt.",
    violation: "Flow or app code depends on Cloudflare directly instead of an injected service.",
    compliant: "The code receives host capabilities as injected services and would run unchanged on another host."
  },
  {
    id: "sdk.extend-never-hand-roll",
    files: [...workerSources, ...browserSources, "db/Database.ts"],
    lookFor: "Does this app file implement general-purpose infrastructure that any Smithers app would need and that " +
      "is not specific to this app's product, such as a model client or model configuration type, an HTTP or " +
      "streaming protocol, a sync or database wrapper, a proxy, a telemetry exporter or relay, or a generic UI " +
      "component?",
    violation: "General-purpose infrastructure is written inside the app instead of a reusable Smithers SDK package.",
    compliant: "The file holds only this app's product behavior and wiring, and uses SDK packages for general " +
      "infrastructure."
  },
  {
    id: "sdk.no-dead-code",
    files: ["src/**/*.ts", "src/**/*.tsx", "worker/**/*.ts", "db/**/*.ts", "e2e/**/*.ts", "bench/**/*.ts"],
    lookFor: "Treat every export as used: other files may import it. Does this file contain dead or duplicate code: " +
      "commented-out code, an unreachable branch, a local declaration or parameter the file never uses, a " +
      "placeholder or TODO stub, or a second implementation of logic the same file already has?",
    violation: "The file contains dead, unused, placeholder or duplicated code.",
    compliant: "Every declaration and branch in the file is used, and nothing is implemented twice.",
    // Advisory: one file shows no cross-file use, and on 2026-10-19 its one finding was a module of used metrics.
    severity: "warning"
  },
  {
    id: "sdk.component-library",
    files: ["src/**/*.css", "src/**/*.tsx"],
    lookFor: "Does this file define reusable visual design, such as colors, typography, buttons, inputs, cards, " +
      "shadows or a generic component, that belongs in the @smthrs/ui component library, rather than only this " +
      "screen's layout (placement, grid, spacing)?",
    violation: "Reusable visual design is defined in the app instead of @smthrs/ui.",
    compliant: "The file uses @smthrs/ui components and tokens and holds only this screen's layout."
  },
  {
    id: "effect.boundary-only",
    files: [...workerSources, "src/!(test)/**/!(*.test).ts", "src/!(*.test).ts", "src/**/!(main).tsx"],
    lookFor: "A DOM listener that must call preventDefault before it returns, and a function a React event handler " +
      "calls to dispatch an action, may run an Effect synchronously. Apart from those, does this file run an Effect, " +
      "with Effect.runPromise, runSync, runFork or runCallback, their ...With forms, a ManagedRuntime or Runtime's " +
      "run methods, or a helper that turns an Effect into a Promise or a callback, for example in a listener whose " +
      "events could be a Stream?",
    violation: "App code runs an Effect, or bridges it to a Promise or callback, where no caller needs it to.",
    compliant: "The file only builds and composes Effects, or bridges synchronously only where its caller must " +
      "have the result before returning."
  },
  {
    id: "effect.wrap-every-library",
    files: [...workerSources, "src/!(test)/**/!(*.test).ts", "src/!(*.test).ts", "db/Database.ts", "db/migrations/*.ts"],
    lookFor: "Does this file call a third-party library's Promise, callback or class API directly in app logic, " +
      "instead of through that library's own Effect API or an Effect wrapper?",
    violation: "App logic calls a third-party library's non-Effect API directly.",
    compliant: "Every library call goes through Effect (effect modules, @effect/* packages, @smthrs/* packages or an " +
      "Effect wrapper), or the file calls no third-party library."
  },
  {
    id: "effect.choices-are-services",
    files: [...workerSources, "src/!(test)/**/!(*.test).ts", "src/!(*.test).ts", "alchemy.run.ts"],
    lookFor: "Does this file hard-code a deployment choice, such as which model or provider to use, a service URL, a " +
      "limit, a timeout or a credential name, inside a handler or module body, instead of reading it from a service " +
      "provided by a layer or from Effect Config with a named default?",
    violation: "A deployment choice is a constant inside a handler or module instead of a layer-provided service or " +
      "Config.",
    compliant: "Deployment choices come from services, layers or Config. Constants that remain are protocol facts, " +
      "limits that are part of an API's documented contract (such as a request size or text length), or defaults " +
      "declared beside the Config that reads them."
  },
  {
    id: "ui.react-is-only-the-view",
    files: ["src/**/*.tsx"],
    lookFor: "Does this React file hold business logic, such as computing, filtering, validating or transforming " +
      "data, calling an API, managing timers or subscriptions, or deciding what happens next, instead of only " +
      "reading live queries or the router, rendering, and dispatching actions?",
    violation: "Business logic lives in a React file.",
    compliant: "The file reads state, renders it and dispatches actions; the logic lives in framework-free modules."
  },
  {
    id: "ui.flux-state",
    files: browserSources,
    lookFor: "Does this file keep application or UI state, meaning values that change as a person uses the app, " +
      "outside the URL route and TanStack DB collections, for example in React state hooks, refs used as a store, " +
      "module-level variables that are reassigned, or a hand-written store or event emitter? Constants, " +
      "configuration, a DOM root, a runtime and a scope are not state.",
    violation: "State lives outside the route and TanStack DB collections.",
    compliant: "All state lives in the route or in TanStack DB collections (local-only collections for one tab's UI " +
      "state)."
  },
  {
    id: "ui.tanstack-router",
    files: browserSources,
    lookFor: "Does this file route by hand: reading or writing window.location or history, matching URL paths, or " +
      "switching screens on the URL, instead of declaring routes and navigating with TanStack Router?",
    violation: "Routing is hand-rolled.",
    compliant: "Routes and navigation go through TanStack Router, or the file does no routing."
  },
  {
    id: "ui.minimal-text",
    files: ["src/**/*.tsx"],
    lookFor: "Does this component show a person text they do not need in order to act, such as an explanation of " +
      "how the product works, a provenance footer, a row whose value is \"not measured yet\", or a sentence beside " +
      "a button that repeats what the button does?",
    violation: "The component shows unneeded explanatory text.",
    compliant: "Visible text is only labels, names, short status and short error messages a person acts on."
  },
  {
    id: "arch.one-responsibility",
    files: [...workerSources, ...browserSources],
    lookFor: "Does this file mix unrelated responsibilities that belong in separate files or folders, such as a " +
      "screen's layout together with feature logic and shared helpers, or several features in one module, so that " +
      "it will not scale as features are added?",
    violation: "The file mixes unrelated responsibilities.",
    compliant: "The file has one clear responsibility that matches its name and folder."
  },
  {
    id: "config.generic-names",
    files: [...workerSources, "src/!(test)/**/!(*.test).ts", "src/!(*.test).ts", "db/Database.ts", "alchemy.run.ts",
      "playwright.config.ts"],
    lookFor: "Does this file name a configuration setting, such as an environment variable, Config key, option or " +
      "type, after one vendor when the setting is generic, for example CEREBRAS_URL for any OpenAI-compatible " +
      "endpoint, or a CerebrasConfig type for any model?",
    violation: "A generic setting is named after a vendor.",
    compliant: "Setting names say what the value is. A credential that only one vendor issues, such as " +
      "CEREBRAS_API_KEY, may carry that vendor's name."
  },
  {
    id: "obs.every-action-observed",
    files: [...workerSources, "src/features/**/!(*.test).ts", "src/!(*.test).ts"],
    lookFor: "Does this file define an action, such as a request handler, a database write, a model call, a " +
      "background program, or what happens when a person does something, that records none of a structured log " +
      "line, a span or a metric for it? A function that only dispatches another action, binds a key or an event to " +
      "an action, forwards a request, or is a query or helper whose caller records the work, is not an action.",
    violation: "An action records no log line, span or metric.",
    compliant: "Every action the file defines records a log line, a span or a metric, or the file defines no action " +
      "of its own.",
    // Advisory: on 2026-10-19 two of its three findings were false (a SQL helper and a store whose actions record).
    severity: "warning"
  },
  {
    id: "obs.content-free",
    files: [...workerSources, "src/!(test)/**/!(*.test).ts", "src/!(*.test).ts"],
    lookFor: "Does any log line, span attribute, span event, error message, error cause or metric attribute in this " +
      "file carry user content or secrets, such as message text, a question, an answer, a prompt, a provider's " +
      "error text or a credential, instead of only ids, counts, durations, sizes, status codes and error codes?",
    violation: "Telemetry or an error in the file can carry content, provider text or a credential.",
    compliant: "Telemetry and errors carry only ids, counts, durations, sizes, status and error codes."
  },
  {
    id: "test.e2e-local-and-live",
    files: ["playwright.config.ts", "e2e/**/*.ts"],
    lookFor: "Is this end-to-end code tied to one environment, such as a hard-coded localhost URL or port, " +
      "local-only file paths, or a dev-only fixture, so the tests cannot run against a live deployment?",
    violation: "The e2e code can run in only one environment.",
    compliant: "The target comes from configuration (BASE_URL), so the same tests run locally and against a " +
      "deployment."
  },
  {
    id: "test.gif-per-flow",
    files: ["playwright.config.ts"],
    lookFor: "Does this Playwright configuration fail to record a video of every test, for example video off, " +
      "'retain-on-failure' or 'on-first-retry' instead of 'on'?",
    violation: "Not every test records video, so a flow can lack a GIF.",
    compliant: "use.video is 'on' for every test."
  },
  {
    id: "test.no-mocks-of-our-code",
    files: testSources,
    lookFor: "Does this file replace our own code or infrastructure, such as a Smithers package, ChatApi, the app's " +
      "modules, Postgres or Electric, with a mock, stub, fake server, fake implementation or spy, instead of running " +
      "the real thing? Scripting the model provider, standing in for Cloudflare's platform bindings, and providing " +
      "a faulty test implementation of an Effect service for an unhappy path are allowed.",
    violation: "Our own code or infrastructure is faked in a test.",
    compliant: "Tests run the real code, Postgres and Electric; only the model provider is scripted, and faults come " +
      "from test implementations of Effect services."
  },
  {
    id: "test.behavioral",
    files: ["**/*.test.ts", "e2e/**/*.spec.ts"],
    lookFor: "Does this test file contain a test that cannot fail or does not test behavior: an assertion that only " +
      "echoes a constant or the test's own setup, a tautology, a test with no meaningful assertion, a fixed sleep " +
      "instead of waiting on a condition or TestClock, or a check that code was called rather than what it did?",
    violation: "At least one test cannot fail, asserts nothing meaningful, echoes constants or sleeps for a fixed time.",
    compliant: "Every test drives behavior through a public interface and asserts observable outcomes that would fail " +
      "if the behavior broke."
  },
  {
    id: "test.skip-only-when-absent",
    files: ["**/*.test.ts", "e2e/**/*.ts"],
    lookFor: "Does this test file skip tests on an error other than a required service being unreachable, or skip " +
      "without saying which service is missing, or swallow a setup or migration failure?",
    violation: "A test skips for a reason other than a missing service, skips silently, or hides a setup failure.",
    compliant: "Tests skip only when a named service is unreachable, and every other setup failure fails them; or " +
      "the file never skips."
  },
  {
    id: "auth.open-but-bounded",
    files: workerSources,
    lookFor: "Does this server code accept input from the network without bounding it, such as no body size limit, " +
      "no allowlist of forwarded parameters, or no length or count limits, or does it add a one-off sign-in, token " +
      "or IP check of its own? A file that only forwards requests to a handler that bounds them is compliant.",
    violation: "Network input is unbounded, or the code adds an ad-hoc auth gate.",
    compliant: "Every network input is bounded by size, allowlist and length, and there is no ad-hoc auth gate; or " +
      "the file handles no network input of its own."
  },
  {
    id: "github.no-actions",
    // PACKAGE.test.ts scans the same files for GitHub's Actions, check and status API paths and events.
    files: appSources,
    lookFor: "Does this file read, write, subscribe to, store or show GitHub Actions, check runs, check suites or " +
      "commit statuses: a GitHub API path under /actions/, check-runs, check-suites or statuses, a check_run, " +
      "check_suite, status, workflow_run or workflow_job webhook event, @smthrs/integrations' GitHub.Actions.CheckRun, " +
      "or a table or view of them? GitHub.Actions in @smthrs/integrations is that SDK's module of integration steps, " +
      "not GitHub Actions, and the app's own /$owner/$repo/actions route lists Smithers flow runs; neither is a " +
      "finding by itself. One write is allowed (ruling GH-10): reporting a Smithers check's own result on a commit " +
      "with GitHub.Statuses.create, as the context smithers/<name>; reading any status back is still a finding.",
    violation: "The file reads, stores or shows GitHub Actions, check runs, check suites or commit statuses, or writes " +
      "any of them other than a Smithers check's own smithers/<name> status.",
    compliant: "The file touches none of GitHub's Actions, check-run, check-suite or commit-status APIs or events, or " +
      "only reports a Smithers check's result as its smithers/<name> status through GitHub.Statuses.create; a pull " +
      "request's checks are Smithers flow runs from the runs table."
  }
]

/**
 * Asks Jev about every covered file. Manual: name it to run it, with `AI_GATEWAY_API_KEY` set.
 *
 * @since 1.0.0
 * @category lint
 */
const jevRulesTarget = JevRules({
  cwd,
  rules: jevRules,
  threshold: 0.7,
  summary: "Will's judgment rules for the MVP app, asked of Jev one file at a time."
})

/**
 * Reviews changed app code against the app's docs (docs.exact): comparing a doc with code reads several files at
 * once, which Jev does not.
 *
 * @since 1.0.0
 * @category review
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd,
  include: [Smithers.glob("src/**"), Smithers.glob("worker/**"), Smithers.glob("db/**"), Smithers.glob("e2e/**")],
  context: [Smithers.file("AGENTS.md"), Smithers.glob("docs/**/*.md")]
})

/** Import alias, pipe form, shadowing and literal allowlist regressions for the guard. */
const workerIoLintTests = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("eslint.worker-inflight.test.mjs")]),
  srcs: [Smithers.file("eslint.worker-inflight.js"), Smithers.file("eslint.config.js")],
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { workerIoLintTests, importRules: importRulesTarget, jevRules: jevRulesTarget, reviewDocsAgainstCode }
})
