# Smithers v2 Follow-up Prompt

You are taking over the Smithers v2 implementation in this repo. The previous agent implemented a full end-to-end skeleton (renderer -> XML AST -> frames -> engine -> tools -> server -> CLI). This prompt is meant to give you the exact map of what exists, what works, what is simplified, and what to fix/extend.

## High-level architecture implemented
- React custom renderer (`react-reconciler`) commits into an in-memory XML AST (SmithersDOM). Every commit is persisted to SQLite as a frame.
- Engine loop: render -> persist frame -> compute runnable tasks -> execute tasks -> persist outputs -> repeat until done.
- Deterministic order: DFS order of task descriptors extracted during commit.
- Durable state stored in SQLite via Drizzle. Internal tables are created on startup.
- Approvals supported. If a task is gated and not approved, it becomes `waiting-approval`.
- Built-in tools (read/write/edit/grep/bash) with sandbox + logging.
- Server and CLI exist, minimal but usable.

## Repo map / key files
- `src/types.ts`: core types (XmlNode, TaskDescriptor, events, props, ctx, SchemaRegistryEntry).
- `src/components.ts`: JSX components (`Workflow`, `Task`, `Sequence`, `Parallel`, `Branch`, `Ralph`). Task now renders JSX/MDX children to markdown via `renderToStaticMarkup`.
- `src/context.ts`: `buildContext()` with `latest()`, `latestArray()`, `iterationCount()` helpers; `createSmithersContext()` for React context + `useCtx()` hook.
- `src/dom/renderer.ts`: React reconciler host config; commits to host tree.
- `src/dom/extract.ts`: converts host tree to XML AST + extracts TaskDescriptor[]; enforces unique task ids. Supports string output keys (resolved later via schema registry).
- `src/utils/xml.ts`: canonical XML serialization.
- `src/db/internal-schema.ts`: Drizzle table definitions for internal tables.
- `src/db/ensure.ts`: `ensureSmithersTables` (raw SQL) for internal tables.
- `src/db/adapter.ts`: `SmithersDb` helper for internal table CRUD.
- `src/db/output.ts`: output row select/upsert + validation.
- `src/db/schema-signature.ts`: schema signature hashing.
- `src/db/snapshot.ts`: loads input + outputs snapshot for render.
- `src/engine/scheduler.ts`: builds plan tree from XML, deterministic scheduling, sequence/parallel/ralph gating (ralph until only).
- `src/engine/index.ts`: main engine loop; runWorkflow + renderFrame. Resolves string output keys via schema registry. Auto-retries with Zod error + schema description on validation failure.
- `src/engine/approvals.ts`: approve/deny helpers.
- `src/tools/index.ts`: built-in tools + logging via tool context.
- `src/tools/context.ts`: AsyncLocalStorage tool context.
- `src/server/index.ts`: minimal HTTP server with SSE; run/resume/cancel/approve/deny/status/frames.
- `src/cli/index.ts`: CLI wrapper.
- `src/pi-plugin/index.ts`: minimal pi plugin using server HTTP API.
- `src/mdx-components.ts`: MDX component overrides that render markdown via React Fragments (no HTML tags).
- `src/mdx-plugin.ts`: Bun plugin for `@mdx-js/esbuild` MDX compilation.
- `src/zod-to-table.ts`: `zodToTable()` and `zodToCreateTableSQL()` for auto-generating Drizzle tables from Zod schemas.
- `src/zod-to-example.ts`: `zodSchemaToJsonExample()` for generating JSON examples from Zod schemas.
- `src/index.ts`: public API exports including `createSmithers()` (schema-driven and db-based overloads).

## Runtime semantics currently implemented
- Task ids are required; nodeId = id (no hashing).
- Deterministic DFS order in `extract.ts`.
- Restart rule: if any in-flight task unmounts, cancel all in-progress attempts.
- Approvals: if denied, node is `skipped` if `continueOnFail`, else `failed`.
- Sequence gating: only first non-terminal child in a sequence is runnable.
- Parallel: enforced via task descriptor metadata + per-group maxConcurrency.
- Ralph: only supports a single top-level loop. Iteration stored globally in engine, increments if no runnable nodes and `until` false. **Nested Ralph is NOT fully supported.**
- Task `output` prop accepts either a Drizzle table object or a string key. String keys are resolved at runtime via the workflow's `schemaRegistry`.
- Task `children` can be a string, an output object, or a React element (JSX/MDX). React elements are rendered to markdown via `renderToStaticMarkup` with `markdownComponents`.
- When `outputSchema` is provided and children is a React element, the schema JSON example is auto-injected as a `schema` prop.
- On schema validation failure with `retries > 0`, the retry prompt is augmented with the Zod error message and schema description.
- `createSmithers(zodSchemas)` auto-creates SQLite db, Drizzle tables, and a schema registry. Returns `{ Workflow, useCtx, smithers, db, tables }`.

## What’s simplified / missing
1. **Ralph loop**
   - Single global iteration only; nested loops not supported.
   - The render pipeline uses a global `iteration` to stamp tasks inside Ralph (`src/runtime/iteration.ts`).
   - Scheduler treats `ralph.until === true` as terminal for that subtree.

2. **Resume**
   - Resume uses max iteration from `_smithers_nodes` to set current iteration.
   - No robust multi-loop resume or per-ralph iteration state.

3. **Engine / scheduler**
   - Plan tree is derived from XML AST, not from raw React props. That's fine, but ralph iteration is global.
   - No partial rendering caching or plan diffing.

4. **Server**
   - Runs stored only in-process; list/query of historical runs not implemented.
   - SSE stream only active runs in memory.

5. **Tools**
   - Sandbox is coarse; bash network check is string-based.

6. **Validation / retries**
   - Validation uses drizzle-zod insert schema. Keys are injected before validation.
   - Retries happen by re-looping run; no special retry prompt augmentation.

## Setup / commands
- Install deps: `bun install`
- Typecheck: `bun run typecheck`
- Run CLI: `bun run src/cli/index.ts ...`
- Server: `import { startServer } from "smithers/server"` or run `bun` to execute `src/server/index.ts` (you may create a runner).

## Suggested immediate tasks for next agent
1. **Make Ralph iteration per-loop**
   - Track ralph node id (e.g., include ralph id in TaskDescriptor) and store iteration per ralph.
   - Move from global `setCurrentIteration` to a stack or map keyed by ralph node.
   - Update scheduler to track iteration per ralph and stop per-loop.

2. **Improve server durability**
   - List runs from DB instead of in-memory `runs` map.
   - SSE should read from `_smithers_events` for resumed runs.

3. **More robust plan+resume**
   - Persist restart epochs, stale in-progress cancellation with reason.
   - Persist frame metadata and allow `frames?afterFrameNo` (server already supports `frames`).

4. **Tests**
   - Add integration tests for approvals, restart, parallel limit, and ralph loop.

## Notes / gotchas
- Output validation currently fails if payload includes mismatched runId/nodeId/iteration. Keys are injected before validation to satisfy schemas.
- `loadOutputs` returns rows by both DB table name and schema key, so `ctx.outputs.<schemaKey>` works.
- `TaskDescriptor.parallelGroupId` uses an auto counter in `Parallel` component; not stable across renders if tree structure changes. Consider better deterministic ID.
- `SmithersDb` uses raw Drizzle insert/update/select patterns; internal tables also created via raw SQL in `ensureSmithersTables`.

## Where to start editing
- Ralph iteration: `src/components.ts`, `src/runtime/iteration.ts`, `src/dom/extract.ts`, `src/engine/index.ts`, `src/engine/scheduler.ts`.
- Server DB-run listing: `src/server/index.ts`, `src/db/adapter.ts`, `src/db/internal-schema.ts`.
- Schema-driven API: `src/index.ts` (`createSmithers`), `src/zod-to-table.ts`, `src/zod-to-example.ts`.
- MDX support: `src/mdx-components.ts`, `src/mdx-plugin.ts`, `src/components.ts` (`renderChildrenToText`).
- Context helpers: `src/context.ts` (`latest`, `latestArray`, `iterationCount`, `createSmithersContext`).
- String output keys: `src/dom/extract.ts`, `src/engine/index.ts` (schema registry resolution), `src/types.ts`.

