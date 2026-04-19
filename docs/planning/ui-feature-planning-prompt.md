# Planning Prompt: `ui:` Property for `createSmithers()`

> **Audience**: A planning agent that does not have access to the smithers codebase. This document is the complete context dossier.

---

## Section 0 — What you are planning

Design (do not yet implement) a new feature for smithers: the ability to pass a `ui:` property to `createSmithers()` that attaches a **server-rendered React app** to a smither. The goals, as stated by the project owner:

1. **Vite SSR**: Use Vite as the SSR tool so the UI renders server-side.
2. **Runs anywhere the server runs**: smithers executes on the server; most data/compute lives server-side; the rendered UI is shipped to the browser.
3. **Real-time sync via ElectricSQL**: smithers' SQLite database is the single source of truth. The frontend subscribes via ElectricSQL for live read-side updates (and ideally also writes back through smithers abstractions).
4. **Same SQLite database**: The same file/schema that already backs smithers workflow state is what the UI reads. No parallel "UI DB."
5. **API is "literal smithers code"**: The frontend should interact with smithers via the existing abstractions (Workflows, Tasks, schemas, `smithers` runtime APIs) and the existing SQLite tables — NOT a bespoke REST shim. Direct SQLite server-side, ElectricSQL client-side.
6. **Framework-agnostic core, React-first examples**: The surface should allow non-React UIs later, but v1 ships with React ergonomics.

Your job: produce a **step-by-step implementation plan**: architecture decisions, package boundaries, API shape, build/dev/prod flow, migration steps, open risks. You should produce options with tradeoffs where the right call isn't obvious.

**Constraints from the project owner**: take time on this — it's a big feature. Don't collapse options prematurely. Docs-first authoring (the public API contract must be specified before code is written).

---

## Section 1 — Repo shape

```
/Users/williamcory/smithers/
├── apps/
│   ├── cli/                      # `smithers` CLI entry
│   └── observability/
├── packages/                     # 22 domain packages
├── examples/                     # 100+ .jsx / .mdx workflow examples
├── docs/                         # Mintlify docs site
├── .smithers/                    # Smithers' own workflows (dogfood)
├── scripts/                      # bump.mjs, publish.mjs
├── package.json                  # workspace root
├── pnpm-workspace.yaml
├── bunfig.toml
├── tsconfig.json
├── bun.lock / pnpm-lock.yaml
└── smithers.db (+ -shm, -wal)    # real runtime DB at repo root
```

**Package manager**: `bun` is primary; `pnpm` is used for workspace tasks (e.g. `pnpm -r test`). Both lockfiles are checked in.

**Runtime**: Bun ≥ 1.3.0 required. Uses `bun:sqlite` natively. Not Node-compatible for the SQLite layer without swapping drivers.

### Packages (22, all under `packages/`)

| Package | Role |
|---|---|
| `smithers` | Public facade (`smithers-orchestrator` on npm). `createSmithers`, JSX runtime, `mdx-plugin`. |
| `components` | 50+ React components: `Workflow`, `Task`, `Sequence`, `Parallel`, `Branch`, `Loop`, `Ralph`, `Approval`, `Sandbox`, `Signal`, `Timer`, `HumanTask`, `Saga`, `Kanban`, `Debate`, `ReviewLoop`, etc. |
| `react-reconciler` | Custom React reconciler that renders JSX into Smithers host trees (NOT DOM). Also contains a DOM adapter used only for devtools. |
| `driver` | Workflow driver, `SmithersCtx`, task runner, decision actor. Pure logic (no HTTP). |
| `engine` | Main execution loop. `runWorkflow`, `renderFrame`, hot-reload plumbing. Depends on `@effect/sql-sqlite-bun`, `@effect/platform-bun`. |
| `scheduler` | Pure scheduler decisions (no I/O). |
| `graph` | Framework-neutral DAG/graph extraction from JSX. |
| `db` | SQLite persistence. `SmithersDb` adapter, `zodToTable`, `ensureSmithersTables`, frame codecs, write retries. Uses `drizzle-orm/bun-sqlite` + `@effect/sql`. |
| `server` | Hono-based HTTP + WS gateway. `serve` (single workflow), `gateway` (multi-workflow WebSocket multiplexer), cron, webhooks, metrics. |
| `agents` | AI agent adapters (Anthropic, OpenAI, Gemini, Claude Code, Codex, Amp, Pi, Kimi, Forge). |
| `errors` | Tagged error types + utilities. |
| `observability` | Metrics, logging, OpenTelemetry. |
| `sandbox` | Child-workflow isolation (Nix/Docker). |
| `vcs` | jj workspace operations. |
| `memory` | Persistent + semantic memory. |
| `scorers` | LLM evaluation + aggregation. |
| `openapi` | OpenAPI → AI SDK tool generation. |
| `devtools` | In-process devtools; uses the react-reconciler DOM adapter. |
| `time-travel` | Snapshots, diffs, forks, replay, timelines. |
| `protocol` | Shared wire contracts. |

### Path aliases (`tsconfig.json`)

- `smithers-orchestrator` → `packages/smithers/src/index.js`
- `@smithers-orchestrator/*` → `packages/*/src/index.js` (or sub-paths)
- All 21 sibling packages aliased. User code always imports via these aliases, never relative paths across packages.

### Organization rules (from user's standing preferences — memory notes)

- **One named export per file**, filename matches export name.
- **`index.ts/js` is barrels only** — never implementation.
- **Organize by domain/feature**, not by kind. No `types.ts` / `errors.ts` grab-bags. Colocate types and errors with the thing they describe. Examples: `Task.js` + `TaskProps.ts` live side-by-side; each component in `packages/components/src/components/` is one file.
- **Single-file folders are flattened**: prefer `foo.ts` over `foo/index.ts`.
- **Docs-driven**: update docs/API contracts before code.
- **Doc style**: conceptual = Head First + Kernighan; non-conceptual = pure Kernighan.

Your plan's package/file layout MUST obey these rules.

---

## Section 2 — `createSmithers()` as it exists today

**File**: `packages/smithers/src/create.js` (lines 162–384)
**Options type**: `packages/smithers/src/CreateSmithersOptions.ts`
**Return type**: `packages/smithers/src/CreateSmithersApi.ts`

### Current signature

```ts
function createSmithers<Schemas extends Record<string, z.ZodObject<any>>>(
  schemas: Schemas,
  opts?: CreateSmithersOptions
): CreateSmithersApi<Schemas>
```

### Current options (the place your new `ui` field will land)

```ts
export type CreateSmithersOptions = {
  readableName?: string;
  description?: string;
  alertPolicy?: SmithersAlertPolicy;
  dbPath?: string;
  journalMode?: string;  // default "WAL"
};
```

### Current return API

```ts
export type CreateSmithersApi<Schema = unknown> = {
  Workflow, Approval, Task, Sequence, Parallel, MergeQueue, Branch, Loop,
  Ralph, ContinueAsNew, continueAsNew, Worktree, Sandbox, Signal, Timer,
  useCtx,
  smithers: (build, opts?) => SmithersWorkflow,
  db: BunSQLiteDatabase<Record<string, unknown>>,   // drizzle instance
  tables: { [K in keyof Schema]: unknown },
  outputs: { [K in keyof Schema]: Schema[K] },
};
```

### What `createSmithers` does under the hood (condensed)

```js
// 1. Build Drizzle tables from Zod schemas (schema name -> snake_case table)
const inputTable = schemas.input
  ? zodToTable("input", schemas.input, { isInput: true })
  : sqliteTable("input", {
      runId: text("run_id").primaryKey(),
      payload: text("payload", { mode: "json" }).$type(),
    });
for (const [name, zodSchema] of Object.entries(schemas)) {
  if (name === "input") continue;
  tables[name] = zodToTable(camelToSnake(name), zodSchema);
}

// 2. Open SQLite (bun:sqlite) and apply pragmas
const sqlite = new Database(dbPath);
sqlite.run(`PRAGMA journal_mode = ${opts?.journalMode ?? "WAL"}`);
sqlite.run("PRAGMA busy_timeout = 30000");
sqlite.run("PRAGMA synchronous = NORMAL");
sqlite.run("PRAGMA locking_mode = NORMAL");
sqlite.run("PRAGMA foreign_keys = ON");

// 3. Wrap in Drizzle
const db = drizzle(sqlite, { schema: drizzleSchema });

// 4. Build schema registry (ZodObject -> name, name -> { table, zodSchema })
//    This is what lets runtime code resolve an output schema argument back
//    to its table at execution time.

// 5. Return React components wrapped with a runtime context provider that
//    carries (db, schemaRegistry, alertPolicy, etc.) through the JSX tree.
```

### Hot reload

`SMITHERS_HOT=1` + CLI `--hot`. Key caches the API by `(absDbPath, schemaSignature)` and rejects reload if schema structure changes. Alert policy can update without reload.

---

## Section 3 — SQLite: the source of truth

### Stack
- **Driver**: `bun:sqlite` (native, fast). Not Node-compatible.
- **ORM**: `drizzle-orm/bun-sqlite` v0.45.2 + `drizzle-zod` v0.8.3.
- **Effect integration**: `@effect/sql-sqlite-bun` v0.52.0 (engine), `@effect/sql` v0.51.0 (db).

### Tables present in every smithers database

**User-defined** (auto-generated from `createSmithers` schemas):
- `input` — always present. `run_id PRIMARY KEY, payload JSON`.
- One table per output schema name, snake_cased.

**Internal** (managed by `SmithersDb` / `ensureSmithersTables`):
- `_smithers_runs` — run state
- `_smithers_nodes` — node execution state
- `_smithers_attempts` — attempt history
- `_smithers_frames` — frame snapshots (for time-travel / replay)
- `_smithers_events` — event history
- `_smithers_approvals` — approval/human request state
- `_smithers_signals` — signal state
- `_smithers_alerts` — alert firing state
- `_smithers_cache` — node diff cache

### Path
- Default: `./smithers.db` (CWD-relative).
- Configurable via `createSmithers({ dbPath })`.
- Real file at repo root: `smithers.db` (~86 MB today, plus `-shm`, `-wal`).

### How code accesses the DB
1. CLI loads a workflow file: `import(pathToFileURL(abs).href)`. The default export is a `SmithersWorkflow` object containing a live `db` (Drizzle instance).
2. `ensureSmithersTables(workflow.db)` creates internal tables.
3. `new SmithersDb(workflow.db)` gives the adapter used across engine/server/CLI.

---

## Section 4 — The execution model you're integrating with

**Core mental model** (docs/how-it-works.mdx):

> The React tree is an **execution plan**, not UI. Smithers renders the tree with a custom React reconciler, extracts a graph of Tasks and control-flow nodes, schedules and runs them, writes results to SQLite, and **re-renders the tree** so conditionals (`<Branch if={...}>`, `<Ralph until={...}>`, etc.) can evaluate against updated state. Execution is depth-first, left-to-right, unblocked-only.

### The primitives (in `packages/components/src/components/`)

- `<Workflow name>` — root
- `<Task id output={zodSchema} agent={agent} retries? timeout? deps? skipIf?>` — LLM/compute/static node
- `<Sequence>` / `<Parallel maxConcurrency>` / `<Branch if then else>` / `<Loop until maxIterations>` / `<Ralph>`
- `<Approval>` / `<HumanTask>` / `<Signal>` / `<Timer>`
- `<Sandbox>` / `<Worktree>` / `<Saga>` / `<TryCatchFinally>`
- Domain composites: `<Kanban>`, `<Debate>`, `<CheckSuite>`, `<ReviewLoop>`, etc.

### `SmithersCtx` (what `useCtx()` returns)

```ts
type SmithersCtx<Schema> = {
  input: Schema['input'];
  output(schema, { nodeId }): Row;             // throws if missing
  outputMaybe(schema, { nodeId }): Row | undefined;
  latest(schema, nodeId): Row | undefined;     // highest iteration
  iterationCount(schema, nodeId): number;
  runId: string;
  iteration: number;
  auth?: RunAuthContext | null;
};
```

### `SmithersWorkflow` (the default export of every workflow file)

```ts
type SmithersWorkflow<Schema> = {
  readableName?: string;
  description?: string;
  db: BunSQLiteDatabase;
  build: (ctx: SmithersCtx<Schema>) => React.ReactElement;
  opts: SmithersWorkflowOptions;
  schemaRegistry: Map<string, { table, zodSchema }>;
  zodToKeyName: Map<ZodObject, string>;
};
```

**Note the implication for UI**: workflows already use React, but via a **custom reconciler that emits host elements like `smithers:workflow` / `smithers:task`** — not DOM nodes. The UI feature will need a *separate* render path using standard `react-dom/server` (and Vite) that runs in parallel to — and reads from — the same SQLite DB that the workflow reconciler writes.

---

## Section 5 — Current entry points & servers

### CLI — `apps/cli/src/index.js`

```js
#!/usr/bin/env bun
import { ... } from "@smithers-orchestrator/engine";
import { mdxPlugin } from "smithers-orchestrator/mdx-plugin";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";

async function loadWorkflowAsync(path) {
  const abs = resolve(process.cwd(), path);
  mdxPlugin();
  const mod = await import(pathToFileURL(abs).href);
  if (!mod.default) throw new SmithersError("WORKFLOW_MISSING_DEFAULT", "...");
  return mod.default;
}

async function loadWorkflowDb(workflowPath) {
  const workflow = await loadWorkflow(workflowPath);
  ensureSmithersTables(workflow.db);
  setupSqliteCleanup(workflow);
  return { adapter: new SmithersDb(workflow.db) };
}
```

CLI commands (via **Incur** framework):
```
smithers up workflow.jsx --input '{...}'
smithers up workflow.jsx --run-id abc --resume true
smithers ps
smithers workflow list
smithers approve <runId> --node <nodeId>
smithers deny    <runId> --node <nodeId>
smithers watch run <runId>
```

### HTTP — `packages/server/src/serve.js` (single workflow)
Hono app:
- `POST /` — start run
- `GET /events` — SSE stream
- `POST /approve/:nodeId` / `POST /deny/:nodeId`
- `GET /metrics` (Prometheus)
- `POST /cancel`

### Gateway — `packages/server/src/gateway.js` (multi-workflow)
- WebSocket + HTTP multiplexer.
- Manages many concurrent workflows.
- Used by devtools UI today.

**No public browser UI today**: devtools are CLI/inspector only. No Vite. No ElectricSQL. `react-dom/server` is used in a few places — but ONLY to render MDX/JSX to *text* for LLM prompts (e.g. `components/src/components/Task.js`, `components/src/renderMdx.js`, `engine/src/effect/deferred-state-bridge.js`). It is not used for HTML.

---

## Section 6 — Effect usage

Effect is used heavily *inside* runtime code (engine loop, DB adapter retries, CLI error handling, metrics) but **user/workflow code is plain async/React** — no monadic style leaks out. Plan accordingly: the UI feature's user-facing surface should stay React-idiomatic; any Effect usage belongs in the internals.

Typical internal pattern:
```js
function loadWorkflowEffect(path) {
  return Effect.tryPromise({
    try: () => loadWorkflowAsync(path),
    catch: (cause) => toSmithersError(cause, "cli load workflow"),
  }).pipe(
    Effect.annotateLogs({ workflowPath: path }),
    Effect.withLogSpan("cli:load-workflow"),
  );
}
```

Key Effect packages already present: `effect` v3.21.1, `@effect/sql`, `@effect/sql-sqlite-bun`, `@effect/platform-bun`, `@effect/workflow`, `@effect/experimental`.

---

## Section 7 — TypeScript & JSX setup (critical for the UI feature)

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "smithers-orchestrator",   // <-- !!
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "strict": true
  }
}
```

**The JSX gotcha you must solve**: smithers sets `jsxImportSource: "smithers-orchestrator"` globally, which points JSX at `packages/smithers/src/jsx-runtime.js`. That runtime is written for the Smithers reconciler (workflow graph), not DOM. The UI app needs **standard React JSX** (DOM). Options the planner must weigh:

1. Per-directory / per-file `@jsxImportSource react` override for UI files.
2. A separate `tsconfig.ui.json` for the UI directory.
3. Vite-level JSX config distinct from the host TS config.
4. Two JSX runtimes coexisting by filename convention (e.g., `.ui.tsx` vs `.jsx`).

### Typecheck commands
- `pnpm run typecheck` — all packages
- `pnpm run typecheck:examples` — uses `examples/tsconfig.json`

---

## Section 8 — Example workflow (so you can see what the authoring surface looks like)

`examples/code-review-loop.jsx`:

```jsx
import { Sequence, Ralph } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit.js";
import { ToolLoopAgent as Agent, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ReviewPrompt from "./prompts/code-review-loop/review.mdx";
import FixPrompt from "./prompts/code-review-loop/fix.mdx";

const reviewSchema = z.object({ approved: z.boolean(), feedback: z.string(), issues: z.array(z.string()).optional() });
const fixSchema    = z.object({ filesChanged: z.array(z.string()), changesSummary: z.string() });
const outputSchema = z.object({ finalSummary: z.string(), totalIterations: z.number() });

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  review: reviewSchema, fix: fixSchema, output: outputSchema,
});

// ... agents omitted ...

export default smithers((ctx) => {
  const latestReview = ctx.outputs.review?.[ctx.outputs.review.length - 1];
  const isApproved = latestReview?.approved ?? false;
  return (
    <Workflow name="code-review-loop">
      <Ralph until={isApproved} maxIterations={3} onMaxReached="return-last">
        <Sequence>
          <Task id="review" output={outputs.review} agent={reviewAgent}>
            <ReviewPrompt directory={ctx.input.directory} />
          </Task>
          <Task id="fix" output={outputs.fix} agent={fixAgent} skipIf={isApproved}>
            {(deps) => <FixPrompt feedback={deps.review.feedback} />}
          </Task>
        </Sequence>
      </Ralph>
      <Task id="summary" output={outputs.output}>
        {{ finalSummary: isApproved ? "LGTM" : "...", totalIterations: ctx.outputs.review?.length ?? 0 }}
      </Task>
    </Workflow>
  );
});
```

`examples/_example-kit.js` is a one-liner:
```js
export function createExampleSmithers(schemas) {
  return createSmithers(schemas, { dbPath: "smithers.db" });
}
```

The planner should sketch an equivalently small example for the UI case — e.g. `createSmithers(schemas, { ui: { entry: "./app.tsx" } })` plus an `app.tsx` that reads live data via a smithers-provided hook.

---

## Section 9 — Build / test / scripts

```jsonc
// root package.json scripts (relevant subset)
{
  "typecheck": "tsc --noEmit",
  "typecheck:examples": "tsc -p examples/tsconfig.json --noEmit",
  "lint": "oxlint --react-plugin --node-plugin --import-plugin ...",
  "lint:fix": "oxlint ... --fix ...",
  "cli": "bun run apps/cli/src/index.js",
  "test": "pnpm -r test",
  "docs": "cd docs && bunx mintlify dev",
  "version": "node scripts/bump.mjs",
  "release": "node scripts/publish.mjs"
}
```

**Testing**: Bun's built-in test runner (`bun test`). Tests live in `packages/*/tests/`. No vitest. Example: `packages/components/tests/context.test.js` covers the runtime context API.

**Linting**: `oxlint` with React/Node/import plugins.

**Bundler for published packages**: `tsup` (esbuild).

---

## Section 10 — TOON files

TOON (Token-Oriented Object Notation) is an alternative authoring format for workflow definitions — terse, CSV-style, explicit array lengths. Example (`.smithers/workflows/.worktrees/.../tests/fixtures/toon-research-report.toon`):

```toon
imports:
  agents[1]{from,use}:
    ./toon-agent.ts,"researcher,writer"
name: research-report
input:
  topic: string
steps[2]:
  - id: research
    agent: researcher
    prompt: "Research the topic.\nTopic: {input.topic}\n"
    output:
      summary: string
      keyPoints: "string[]"
  - id: report
    agent: writer
    prompt: "Summary: {research.summary}\nKey points: {research.keyPoints}\n"
    output:
      title: string
      body: string
      wordCount: number
```

TOON compiles to JSX under the hood. Not critical for the UI plan — but note: if you define a `ui:` shape in JS/TS, consider whether/how it surfaces in TOON.

---

## Section 11 — What you're probably about to design (signposts, not the plan)

A non-exhaustive list of decisions the planner must make explicit. Present each as option(s) + tradeoffs, not as a fait accompli.

1. **Package boundary**
   - New package `packages/ui/` (SSR host + client runtime + ElectricSQL client wiring)?
   - Split: `packages/ui-server/` (Vite SSR, Hono integration) + `packages/ui-client/` (React hooks, Electric client)?
   - Or extend `packages/server/`?

2. **`ui:` option shape**
   - `ui: { entry: "./app.tsx" }` vs `ui: App` (imported component) vs `ui: () => App` (lazy).
   - Build-time (user runs `vite build`) vs runtime (smithers bundles with `vite` programmatically).
   - Framework-agnostic hatch: `ui: { render: ({ url, db }) => Promise<string> }` as the lowest level, with a React sugar on top.

3. **Vite integration**
   - `createServer({ middlewareMode: true })` + mount into the existing Hono server (`packages/server/src/serve.js` / `gateway.js`).
   - Dev vs prod split: dev uses Vite's SSR dev server (HMR), prod uses pre-built manifest.
   - Where the Vite config lives (package-owned default that user can extend).

4. **ElectricSQL integration**
   - ElectricSQL's Postgres-centric model vs smithers' SQLite — does this require PGlite on the client and a sync bridge on the server? Or a different sync approach (Cloudflare Durable Objects? a custom SSE-driven read-model?).
   - What subset of tables is exposed to the client (probably read-only projection of user tables + selected `_smithers_*` tables, not raw internals).
   - Auth/authorization story for cross-tenant scenarios.
   - Bi-directional writes: must go through smithers abstractions (signals, approvals, `input`), not raw table writes from the client.

5. **Frontend data API**
   - A React hook like `useSmithers()` / `useRun(runId)` / `useOutput(schema, { nodeId })` that mirrors `SmithersCtx` but client-side, backed by the Electric store.
   - Respect the "one export per file" rule.
   - Framework-agnostic core (plain observables) + React hooks layer on top.

6. **DB schema & Electric**
   - Same `smithers.db`, same tables. No parallel DB.
   - Which tables to mark syncable. Schema changes (hot reload) must propagate.
   - How ElectricSQL's expected shape (shapes, subscribe primitives) maps onto Drizzle-generated tables.

7. **Hot reload coherence**
   - `SMITHERS_HOT=1` already handles workflow reload w/ schema signature checks.
   - UI HMR via Vite must coordinate: schema changes invalidate both sides; UI-only changes hot-swap via Vite alone.

8. **JSX runtime conflict** (see Section 7). Pick one concrete approach.

9. **CLI surface**
   - `smithers up workflow.jsx --ui` to also serve UI?
   - `smithers dev` as a new command for the Vite dev path?
   - `smithers build` to produce the SSR bundle?

10. **Deployment**
    - Single Bun binary with embedded assets vs separate static host.
    - Where the SSR manifest/build artifacts live.

11. **Errors & boundaries**
    - UI render failures must not crash the workflow engine.
    - Pipe UI-surface errors through `@smithers-orchestrator/errors` tagged-error patterns.

12. **Testing story**
    - Bun test for server SSR rendering.
    - Playwright/browser for end-to-end? (Not currently in the repo.)
    - Electric sync integration tests.

13. **Docs**
    - New Mintlify section in `docs/` — per the user's "docs first" rule, the docs contract is written BEFORE code.
    - Head First style for the conceptual intro ("what does `ui:` buy you?"); Kernighan style for the reference.

---

## Section 12 — What the planner should produce

1. **A public API contract** — the shape of the new `ui:` option, the return additions (if any) on `CreateSmithersApi`, and client-side exports. Written as if it were the reference doc.
2. **Architecture diagram (ASCII ok)** — how requests flow: browser → Hono → Vite SSR → React render → (reads from) SQLite; and browser → Electric client → (reads shapes from) Electric server → SQLite.
3. **Package-by-package plan** — new packages, new files (respecting one-export-per-file + barrel-only index), new root/workspace changes, new dependencies with versions.
4. **Build flow** — dev (HMR) and prod (bundle + serve) with exact commands.
5. **CLI changes** — any new commands/flags, in line with the Incur setup.
6. **Schema & Electric wiring** — what tables sync, read vs write, auth boundary.
7. **Migration plan** — how existing workflows (no `ui:`) remain unaffected.
8. **Test plan** — what to unit/integration/e2e test, and where tests live.
9. **Open risks & unknowns** — explicitly call out things that need a spike (ElectricSQL↔SQLite fit is the biggest).
10. **Docs outline** — pages to add under `docs/`, written before implementation.

Phase the work. Call out what must ship in v1 vs what can wait (e.g., framework-agnostic hatch in v1 but only React sugar in v2 — or vice versa).

---

## Section 13 — Known unknowns the planner should resolve (or spike)

1. **ElectricSQL + SQLite**: ElectricSQL is Postgres-native. Does the project use a PGlite adaptor, a custom sync protocol, or something else? A prototype/spike is probably required before committing.
2. **Where Vite lives**: dependency of the new UI package, or peer dep the user brings? (Argument for peer: user may want to pin.)
3. **HMR + hot reload**: smithers already has its own hot-reload notion; does Vite's HMR coexist or does smithers delegate?
4. **Auth story** for the UI endpoints — there's a `RunAuthContext` in `SmithersCtx` but no full auth system visible in the server package.
5. **Approvals UX**: today approvals are HTTP (`POST /approve/:nodeId`). Should the UI use the Electric-synced `_smithers_approvals` table + an RPC, or keep the REST endpoint?
6. **Writing from the client**: user wants "literal smithers code" — what does writing look like? Probably a thin RPC layer that wraps `SmithersDb` operations + a subset of engine actions (start run, send signal, approve). Planner must define this.
7. **Typing**: the DX promise of "the SQLite API" on the client — can we regenerate TS types for Electric shapes from the same Zod schemas passed to `createSmithers`? (Likely yes; plan it.)
8. **Framework-agnostic ambition**: how much abstraction is v1 willing to eat? A small interface (`{ render(url, ctx): Promise<{ html, head }> }`) may be cheap; a deep framework-neutral hook API is not.
9. **Build artifact location**: where does the compiled SSR bundle go? `dist/ui/`? Per-smither or per-workflow?
10. **Multi-smither apps**: the gateway runs many workflows. One UI per smither? Or one UI spanning many? (Probably per-smither in v1.)

---

**Final instruction to the planner**: Produce the plan as markdown. Favor clarity over brevity but do not pad. Where a decision is a real judgment call, show 2–3 options with tradeoffs and a recommendation — don't hide the alternatives. Docs and API contracts come before code. Respect the one-export-per-file / barrel-only-index / domain-colocation rules in every file you propose.
