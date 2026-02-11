# Smithers

Define AI workflow graphs with JSX. Deterministic execution with durable state in SQLite (Drizzle).

## Installation

**Requirements**

- Bun >= 1.3 (Smithers uses Bun SQLite and Bun runtime APIs)

```bash
bun add smithers ai @ai-sdk/anthropic drizzle-orm drizzle-zod
```

Smithers optionally integrates with [JJ (Jujutsu)](https://github.com/martinvonz/jj) for codebase snapshots:

```bash
brew install jj

```

or see https://martinvonz.github.io/jj/latest/install/ (if JJ is not installed, pointers are recorded as `null`).

## Quick Start

### Schema-Driven (Recommended)

The simplest way to use Smithers. Define Zod schemas for your outputs and let the framework handle SQLite, Drizzle tables, and storage automatically.

```tsx
// workflow.tsx
import { createSmithers, Task, Sequence } from "smithers";
import { agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

// Define output schemas with Zod
const analyzeSchema = z.object({
  summary: z.string(),
  files: z.array(z.string()),
});

const reviewSchema = z.object({
  approved: z.boolean(),
});

// createSmithers auto-creates SQLite db + Drizzle tables from Zod schemas
const { Workflow, useCtx, smithers } = createSmithers({
  analyze: analyzeSchema,
  review: reviewSchema,
});

// Create agents
const codeAgent = agent({
  model: anthropic("claude-sonnet-4-20250514"),
  system: "You are a senior software engineer.",
});

const reviewAgent = agent({
  model: anthropic("claude-sonnet-4-20250514"),
  system: "You are a code reviewer.",
});

// Export workflow — use string keys for output instead of table objects
export default smithers((ctx) => (
  <Workflow name="example">
    <Task id="analyze" output="analyze" outputSchema={analyzeSchema} agent={codeAgent}>
      {`Analyze: ${ctx.input.description}`}
    </Task>
    <Task id="review" output="review" outputSchema={reviewSchema} agent={reviewAgent}>
      {`Review: ${ctx.output("analyze", { nodeId: "analyze" }).summary}`}
    </Task>
  </Workflow>
));
```

```bash
smithers run workflow.tsx --input '{"description": "Fix auth bugs"}'
```

### Manual Mode (Advanced)

If you need full control over the database and table definitions, use the original `smithers()` API:

```tsx
// workflow.tsx
import { smithers, Workflow, Task, Sequence } from "smithers";
import { agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";

// Define tables manually
const inputTable = sqliteTable("input", {
  runId: text("run_id").primaryKey(),
  description: text("description").notNull(),
});

const analyzeTable = sqliteTable(
  "analyze",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    summary: text("summary").notNull(),
    files: text("files", { mode: "json" }).$type<string[]>(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId] }),
  }),
);

const reviewTable = sqliteTable(
  "review",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    approved: integer("approved", { mode: "boolean" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.nodeId] }),
  }),
);

// Schema and db
export const schema = {
  input: inputTable, // reserved: workflow input
  output: reviewTable, // reserved: workflow output
  analyze: analyzeTable,
};

export const db = drizzle("./workflow.db", { schema });

// Create agents
const codeAgent = agent({
  model: anthropic("claude-sonnet-4-20250514"),
  system: "You are a senior software engineer.",
});

const reviewAgent = agent({
  model: anthropic("claude-sonnet-4-20250514"),
  system: "You are a code reviewer.",
});

// Export workflow
export default smithers(db, (ctx) => (
  <Workflow name="example">
    <Sequence>
      <Task id="analyze" output={schema.analyze} agent={codeAgent}>
        {`Analyze: ${ctx.input.description}`}
      </Task>
      <Task id="review" output={schema.output} agent={reviewAgent}>
        {`Review: ${ctx.output(schema.analyze, { nodeId: "analyze" }).summary}`}
      </Task>
    </Sequence>
  </Workflow>
));
```

Note: `<Workflow>` sequences its direct children by default, so `<Sequence>` is optional at the root.

Note: output tables must include `runId` and `nodeId`. Looping tasks add `iteration`.

## How It Works

1. Define Drizzle tables. `schema.input` and `schema.output` are reserved.
2. Smithers renders the React tree, assigns NodeIds, and loads outputs from SQLite.
3. It selects runnable nodes in deterministic order and executes them in an engine phase.
4. Output is validated and written to SQLite with `(runId, nodeId[, iteration])`.
5. The tree re-renders with updated `ctx` until no runnable nodes remain.

---

## Execution Model

Smithers is built on React, but render is pure. Side effects happen only in the engine phase.

### Deterministic Node Identity

Each `<Task>` must have an explicit `id`. Node identity is deterministic:

NodeId = `id`

Rules:

- `id` is required and must be unique per workflow frame.
- Duplicate ids fail the run deterministically.
- React `key` is only for React list rendering and does not affect NodeId.
- `<Ralph>` iterations reuse the same NodeId and are disambiguated by `iteration`.

### Node States

Node state is stored per `(runId, nodeId)` in SQLite.

| State              | Description                              |
| ------------------ | ---------------------------------------- |
| `pending`          | Known, not yet started                   |
| `waiting-approval` | Awaiting human approval                  |
| `in-progress`      | Currently executing                      |
| `finished`         | Completed successfully                   |
| `failed`           | Completed with error (after retries)     |
| `cancelled`        | Unmounted or cancelled while in-progress |
| `skipped`          | Skipped by `skipIf` or branch not taken  |

### Attempts and Retries

Retries create multiple attempts for the same node. The node state is the latest attempt outcome.

Recommended attempt table schema:

- `runId` (string)
- `nodeId` (string)
- `attempt` (integer)
- `state` (string)
- `startedAt` (timestamp)
- `finishedAt` (timestamp)
- `error` (string or JSON)
- `jjPointer` (string)
- `logs` (JSON)

`NodeRetrying` is emitted when a new attempt is scheduled. A retry never overwrites a previous attempt row.

### Task Selection and Idempotency

- Tasks are executed in deterministic depth-first, left-to-right order of the React tree.
- A task runs only when its output row for `(runId, nodeId[, iteration])` is missing or invalid.
- Completed tasks are not re-run unless invalidated or explicitly forced.
  `<Workflow>` children run as an implicit `<Sequence>`. For other ordering needs, use `<Sequence>`, `<Branch>`, or explicit guards, or the output may be missing.

### Output Tables and Keys

Output tables must include:

- `runId` (string)
- `nodeId` (string)
- `iteration` (integer, optional, default 0)

Primary key:

- `(runId, nodeId)` for non-loop tasks
- `(runId, nodeId, iteration)` for `<Ralph>` tasks

If multiple nodes write to the same output table, rows are distinguished by `nodeId`.
Smithers populates `runId`, `nodeId`, and `iteration` automatically; if a task returns them explicitly, they must match or validation fails.

### Structured Output and Validation

Smithers validates all task outputs against the table schema.

Rules:

- For agent tasks, the model must return JSON that matches the output schema.
- Validation uses `drizzle-zod` schemas derived from the table definition.
- On validation failure, the attempt is marked failed and the node may retry.

### Auto-Retry with Schema Feedback

When a task fails schema validation (with `retries > 0`), Smithers automatically augments the retry prompt with the Zod validation error and a description of the expected schema, helping the agent self-correct.

### React Execution Contract

- Rendering is pure and must not perform side effects.
- Graph walking and task execution happen after render.
- `<Parallel>` schedules concurrently but respects `maxConcurrency`.
- Ordering for cache and resume is derived from NodeId, not scheduling time.

### Dynamic Plans

Define `schema.plan` and `schema.implement` with `runId` and `nodeId` columns, same as `schema.analyze`.

```tsx
export default smithers(db, (ctx) => (
  <Workflow name="dynamic">
    <Task id="analyze" output={schema.analyze} agent={codeAgent}>
      {`Analyze: ${ctx.input.description}`}
    </Task>

    {ctx.output(schema.analyze, { nodeId: "analyze" }).complexity === "high" ? (
      <Sequence>
        <Task id="plan" output={schema.plan} agent={codeAgent}>
          {`Create detailed plan for: ${ctx.output(schema.analyze, { nodeId: "analyze" }).summary}`}
        </Task>
        <Task id="implement" output={schema.implement} agent={codeAgent}>
          {`Implement plan: ${ctx.output(schema.plan, { nodeId: "plan" }).steps}`}
        </Task>
      </Sequence>
    ) : (
      <Task id="implement" output={schema.implement} agent={codeAgent}>
        {`Quick fix: ${ctx.output(schema.analyze, { nodeId: "analyze" }).summary}`}
      </Task>
    )}

    <Task id="review" output={schema.output} agent={reviewAgent}>
      {`Review: ${ctx.output(schema.implement, { nodeId: "implement" }).code}`}
    </Task>
  </Workflow>
));
```

### Cancellation

If a task unmounts while `in-progress`:

- Execution is cancelled
- State set to `cancelled`
- No output is saved
- Unmount detection happens on each engine render tick (not mid-attempt)

### Reverting

Smithers records a JJ pointer per attempt when JJ is available. It does not automatically revert or restore the repo.

---

## JJ Integration

Smithers records the current JJ change id (when JJ is installed) at the end of each attempt. It does not perform restores automatically.

---

## Approval Flow

Tasks with `needsApproval` enter `waiting-approval` and emit `ApprovalRequested`. Execution continues for other nodes when possible.

Approval state is stored in SQLite.

Default CLI:

- `smithers approve workflow.tsx --run-id <id> --node-id <id> [--note "..."]`
- `smithers deny workflow.tsx --run-id <id> --node-id <id> [--note "..."]`

On deny, the node transitions to `skipped` unless `continueOnFail=false`, in which case it becomes `failed`.

---

## Caching

`<Workflow cache />` enables per-node caching.

Cache key inputs:

- workflow name and NodeId
- prompt text or direct output payload
- model id and parameters
- tool allowlist and tool versions
- output schema version
- JJ pointer (change or operation id)

If any input changes, the cache is invalidated.

---

## Context API

`ctx` provides typed access to input and outputs.

```tsx
ctx.input; // input row

ctx.outputs.analyze; // array of rows for this table
ctx.output(schema.analyze, { nodeId: "analyze" }); // specific row (by table object)
ctx.output("analyze", { nodeId: "analyze" }); // specific row (by string key)
ctx.output(schema.output, { nodeId: "review", iteration: 2 }); // loop iteration row

ctx.runId; // current run ID
ctx.iteration; // current loop iteration (inside <Ralph>)
ctx.iterations; // per-Ralph iteration map (keyed by Ralph id)

// New helpers
ctx.latest(schema.analyze, "analyze"); // latest row for nodeId (highest iteration)
ctx.latest("analyze", "analyze"); // same, using string key
ctx.latestArray(value, zodSchema); // parse + validate an array field, dropping invalid items
ctx.iterationCount(schema.analyze, "analyze"); // count distinct iterations for a nodeId
```

If multiple `<Ralph>` loops exist, use `ctx.iterations[ralphId]`. `ctx.iteration` is only set when a single loop is present.

Use `ctx.output(...)` for deterministic access to a specific row. Use `ctx.outputs.<table>` when you need to scan or aggregate multiple rows.

### `useCtx()` Hook

When using `createSmithers()`, you get a `useCtx()` hook for accessing the context inside React components:

```tsx
const { Workflow, useCtx, smithers } = createSmithers({ ... });

function MyPrompt() {
  const ctx = useCtx();
  return <>{`Analyze: ${ctx.input.description}`}</>;
}

export default smithers((ctx) => (
  <Workflow name="example">
    <Task id="analyze" output="analyze" agent={codeAgent}>
      <MyPrompt />
    </Task>
  </Workflow>
));
```

---

## Elements

### `<Workflow>`

Root container.

```tsx
<Workflow name="my-pipeline" cache>
  {/* children */}
</Workflow>
```

| Prop    | Type      | Description           |
| ------- | --------- | --------------------- |
| `name`  | `string`  | Name of the workflow  |
| `cache` | `boolean` | Enable output caching |

`<Workflow>` treats its direct children as an implicit `<Sequence>` (left-to-right).

---

### `<Task>`

A single task node.

- With `agent` prop: children is a prompt (string, JSX, or MDX component), Smithers calls the agent
- Without `agent`: children is the output object directly

```tsx
// Agent task - prompt string
<Task id="analyze" output={schema.analyze} agent={codeAgent}>
  {`Analyze: ${ctx.input.description}`}
</Task>

// Agent task - string output key (with createSmithers)
<Task id="analyze" output="analyze" outputSchema={analyzeSchema} agent={codeAgent}>
  {`Analyze: ${ctx.input.description}`}
</Task>

// Agent task - JSX/MDX prompt (rendered to markdown automatically)
<Task id="analyze" output="analyze" outputSchema={analyzeSchema} agent={codeAgent}>
  <AnalyzePrompt />
</Task>

// Hardcoded task - output directly
<Task id="setup" output={schema.setup}>
  {{ files: fs.readdirSync("./src") }}
</Task>
```

| Prop             | Type                    | Description                                                          |
| ---------------- | ----------------------- | -------------------------------------------------------------------- |
| `id`             | `string`                | Stable identity for this node (required)                             |
| `output`         | `Table \| string`       | Drizzle table or string key (resolved via schema registry)           |
| `outputSchema`   | `ZodObject`             | Optional Zod schema for structured output validation                 |
| `agent`          | `Agent`                 | AI SDK agent (if provided, children -> prompt)                       |
| `skipIf`         | `boolean`               | Skip if true                                                         |
| `needsApproval`  | `boolean`               | Require human approval                                               |
| `timeoutMs`      | `number`                | Max duration in ms before failing                                    |
| `retries`        | `number`                | Retry count on failure (default: 0)                                  |
| `continueOnFail` | `boolean`               | Continue workflow if task fails                                      |
| `children`       | `string \| Row \| JSX`  | Prompt (with agent) or output (without). JSX is rendered to markdown |

When rendering arrays or loops, use React `key` on `<Task>` or its wrapper for React list stability. NodeId is still derived solely from `id`.

When `outputSchema` is provided and children is a React element, the schema is automatically injected as a JSON example into the prompt.

---

### `<Sequence>`

Execute children one after another.

`<Workflow>` already behaves like a sequence at the root, so `<Sequence>` is mainly for grouping or enforcing order inside other structures (e.g. `<Parallel>`).

```tsx
<Sequence>
  <Task id="step1" output={schema.step1}>
    {{ done: true }}
  </Task>
  <Task id="step2" output={schema.step2}>
    {{ done: true }}
  </Task>
</Sequence>
```

| Prop     | Type      | Description               |
| -------- | --------- | ------------------------- |
| `skipIf` | `boolean` | Skip all children if true |

---

### `<Parallel>`

Execute children concurrently.

```tsx
<Parallel maxConcurrency={4}>
  <Task id="test" output={schema.test}>
    {{ passed: true }}
  </Task>
  <Task id="lint" output={schema.lint}>
    {{ errors: 0 }}
  </Task>
</Parallel>
```

| Prop             | Type      | Description                    |
| ---------------- | --------- | ------------------------------ |
| `maxConcurrency` | `number`  | Max parallel tasks (default ∞) |
| `skipIf`         | `boolean` | Skip all children if true      |

---

### `<Ralph>`

Iterative loop until condition is met.

```tsx
<Ralph
  until={ctx.output(schema.output, { nodeId: "review" }).approved}
  maxIterations={3}
>
  <Task id="review" output={schema.output} agent={reviewAgent}>
    {`Review this implementation: ${ctx.output(schema.implement, { nodeId: "implement" }).code}`}
  </Task>
</Ralph>
```

| Prop            | Type      | Description                 |
| --------------- | --------- | --------------------------- | --------------------------------- |
| `until`         | `boolean` | Stop when true              |
| `maxIterations` | `number`  | Max iterations (default: 5) |
| `skipIf`        | `boolean` | Skip loop if true           |
| `onMaxReached`  | `"fail"   | "return-last"`              | Behavior at max (default: return) |

---

### `<Branch>`

Conditional branching.

```tsx
<Branch
  if={ctx.output(schema.test, { nodeId: "test" }).passed}
  then={
    <Task id="deploy" output={schema.deploy}>
      {{ url: "https://prod.app" }}
    </Task>
  }
  else={
    <Task id="fix" output={schema.fix} agent={codeAgent}>
      {`Fix this error: ${ctx.output(schema.test, { nodeId: "test" }).error}`}
    </Task>
  }
/>
```

| Prop     | Type      | Description                 |
| -------- | --------- | --------------------------- |
| `if`     | `boolean` | Condition to evaluate       |
| `then`   | `Element` | Execute if true             |
| `else`   | `Element` | Execute if false (optional) |
| `skipIf` | `boolean` | Skip entire branch if true  |

---

## Running Workflows

### CLI

```bash
# Start a new run
smithers run workflow.tsx --input '{"description": "Fix bugs"}'

# Resume a failed/cancelled run
smithers resume workflow.tsx --run-id abc123

# List runs
smithers list workflow.tsx

# Approve or deny a gated node
smithers approve workflow.tsx --run-id abc123 --node-id analyze
smithers deny workflow.tsx --run-id abc123 --node-id review
```

Run options:

- `--root PATH` sets the tool sandbox root (defaults to the workflow directory).
- `--log-dir PATH` sets the event log output directory (relative to root).
- `--no-log` disables event log file output.
- `--allow-network` permits network access for the `bash` tool.
- `--max-output-bytes N` caps tool output size.
- `--tool-timeout-ms N` sets the tool timeout.

### Programmatic

```tsx
import { runWorkflow, renderFrame } from "smithers";
import workflow from "./workflow";

const results = await runWorkflow(workflow, {
  input: { description: "Fix bugs" },
  onProgress: (event) => console.log(event.type),
});

const snapshot = await renderFrame(workflow, {
  runId: results.runId,
  iteration: 0,
  input: { description: "Fix bugs" },
  outputs: {},
});
```

### Server

You can run Smithers as an HTTP server with optional auth and request limits:

```ts
import { startServer } from "smithers/server";

startServer({
  port: 7331,
  rootDir: process.cwd(), // constrain workflow paths + tool sandbox
  authToken: process.env.SMITHERS_API_KEY, // optional (or set SMITHERS_API_KEY)
  maxBodyBytes: 1_048_576, // optional
});
```

### Production Notes

- Set `authToken` (or `SMITHERS_API_KEY`) in server mode.
- Provide a `db` option to enable `/v1/runs` listing and a central run registry.
- Review `docs/production.md` for limits, security, and operational guidance.

---

## `createSmithers()` API

`createSmithers()` is the recommended way to set up a workflow. It accepts either Zod schemas (schema-driven mode) or a pre-configured Drizzle db (manual mode).

### Schema-Driven Mode

Pass a record of Zod schemas. Smithers auto-creates the SQLite database, generates Drizzle tables (with `runId`, `nodeId`, `iteration` columns), and manages the schema registry.

```tsx
import { createSmithers, Task } from "smithers";
import { z } from "zod";

const { Workflow, useCtx, smithers, db, tables } = createSmithers(
  {
    discover: z.object({ topics: z.array(z.string()) }),
    research: z.object({ summary: z.string(), sources: z.array(z.string()) }),
  },
  { dbPath: "./my-workflow.db" }, // optional, defaults to ./smithers.db
);
```

Returns:

| Property   | Type                  | Description                                           |
| ---------- | --------------------- | ----------------------------------------------------- |
| `Workflow` | Component             | Workflow root (wraps context provider)                 |
| `useCtx`   | `() => SmithersCtx`   | React hook for accessing workflow context              |
| `smithers` | Function              | Creates a runnable workflow (pass to `runWorkflow`)    |
| `db`       | `BunSQLiteDatabase`   | The auto-created Drizzle database instance             |
| `tables`   | `Record<string, any>` | Generated Drizzle table objects, keyed by schema name  |

Tasks use string keys for `output` instead of table objects:

```tsx
<Task id="discover" output="discover" outputSchema={discoverSchema} agent={myAgent}>
  ...
</Task>
```

### Manual Mode

Pass an existing Drizzle db instance for full control over table definitions:

```tsx
import { createSmithers } from "smithers";

const { Workflow, useCtx, smithers } = createSmithers(db);
```

---

## MDX Support

Smithers supports MDX files as task prompts. MDX content is automatically rendered to clean markdown text (not HTML) using custom components.

### Setup

Register the MDX plugin in your workflow entry file:

```tsx
import { mdxPlugin } from "smithers";

// Register before importing .mdx files
mdxPlugin();
```

### Usage

```mdx
{/* prompts/analyze.mdx */}
# Analysis Task

Analyze the codebase in **{props.directory}**.

## Focus Areas

- {props.focus}
- Code quality
- Security
```

```tsx
import AnalyzePrompt from "./prompts/analyze.mdx";

<Task id="analyze" output="analyze" agent={codeAgent}>
  <AnalyzePrompt directory="./src" focus="performance" />
</Task>
```

The MDX component is rendered to markdown via `renderToStaticMarkup` with `markdownComponents` that output plain text instead of HTML tags.

### Utilities

```tsx
import { markdownComponents, renderMdx } from "smithers";

// Render an MDX component to markdown string manually
const md = renderMdx(MyMdxComponent, { someProp: "value" });
```

---

## Zod Utilities

Smithers exports utilities for working with Zod schemas:

```tsx
import { zodToTable, zodToCreateTableSQL, zodSchemaToJsonExample, unwrapZodType } from "smithers";

// Generate a Drizzle sqliteTable from a Zod object schema
const table = zodToTable("my_table", myZodSchema);

// Generate CREATE TABLE SQL from a Zod schema
const sql = zodToCreateTableSQL("my_table", myZodSchema);

// Generate a JSON example from a Zod schema (for prompt injection)
const example = zodSchemaToJsonExample(myZodSchema);
// => '{ "name": "string", "age": 0, "active": false }'

// Unwrap nullable/optional/default wrappers to get the base Zod type
const base = unwrapZodType(z.string().nullable().optional());
```

---

## Progress Events

```tsx
onProgress: (event) => {
  switch (event.type) {
    // Run lifecycle
    case "RunStarted":
      break;
    case "RunFinished":
      break;
    case "RunFailed":
      break;

    // Node lifecycle
    case "NodeStarted":
      break;
    case "NodeFinished":
      break;
    case "NodeFailed":
      break;
    case "NodeSkipped":
      break;
    case "NodeCancelled":
      break;
    case "NodeRetrying":
      break;
    case "NodeWaitingApproval":
      break;

    // Revert
    case "RevertStarted":
      break;
    case "RevertFinished":
      break;

    // Approval
    case "ApprovalRequested":
      break;
    case "ApprovalGranted":
      break;
    case "ApprovalDenied":
      break;
  }
};
```

---

## Type Safety

The context is typed based on your exported schema:

```tsx
export const schema = {
  input: inputTable,
  analyze: analyzeTable,
  output: outputTable,
};

ctx.input; // -> { runId, description }
ctx.outputs.analyze; // -> AnalyzeRow[]
ctx.output(schema.analyze, { nodeId: "analyze" }); // -> AnalyzeRow
```

---

## Built-in Tools

Smithers provides common tools for agents:

```tsx
import { read, edit, bash, grep, write } from "smithers/tools";

const codeAgent = agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, edit, bash, grep, write },
  system: "You are a senior software engineer.",
});
```

| Tool    | Description                  |
| ------- | ---------------------------- |
| `read`  | Read file contents           |
| `edit`  | Replace text in a file       |
| `write` | Create or overwrite a file   |
| `bash`  | Execute shell commands       |
| `grep`  | Search for patterns in files |

### Sandboxing and Auditing

- Tools run with cwd at the workflow root
- Path traversal outside the root is rejected
- `bash` is network-disabled by default unless explicitly enabled
- Resource limits apply (timeout, max output, max file size)
- All tool calls are logged per attempt with stdout, stderr, and exit code
