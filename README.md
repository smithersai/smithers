# Smithers

Define AI workflow graphs with JSX. Deterministic execution with durable state in SQLite (Drizzle).

## Installation

```bash
bun add smithers ai @ai-sdk/anthropic drizzle-orm drizzle-zod
```

Smithers also requires [JJ (Jujutsu)](https://github.com/martinvonz/jj) for codebase snapshots:

```bash
brew install jj

```

or see https://martinvonz.github.io/jj/latest/install/

## Quick Start

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

// Define tables
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

```bash
smithers run workflow.tsx --input '{"description": "Fix auth bugs"}'
```

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

Each `<Task>` is assigned a stable NodeId used for resume, caching, and persistence.

NodeId = hash(workflow name + output table name + React path + explicit `id` or React `key`)

Rules:

- Use `id` on `<Task>` for stable identity across refactors.
- When rendering arrays, loops, or branches, always provide a React `key`.
- If the NodeId changes, Smithers treats the node as new and will not reuse old outputs.
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
  If a task reads another node's output, ensure ordering with `<Sequence>`, `<Branch>`, or explicit guards, or the output may be missing.

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

### Reverting

If a past node's output changes:

1. Smithers invalidates downstream nodes in the same run
2. Smithers restores the repo to the JJ pointer recorded for that node attempt
3. Execution resumes from the changed node

---

## JJ Integration

Smithers records a JJ pointer per attempt to enable time travel. Two modes are supported.

- Change-based (default): store the change id for the working copy at the end of each attempt and restore with `jj edit <change>`.
- Operation-based: store the operation id and restore with `jj operation restore <op>`.

JJ already snapshots the working copy automatically for most commands, so Smithers does not require manual `jj snapshot`. Configure JJ ignore and snapshot settings to avoid capturing junk files.

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
ctx.output(schema.analyze, { nodeId: "analyze" }); // specific row
ctx.output(schema.output, { nodeId: "review", iteration: 2 }); // loop iteration row

ctx.runId; // current run ID
ctx.iteration; // current loop iteration (inside <Ralph>)
```

Use `ctx.output(...)` for deterministic access to a specific row. Use `ctx.outputs.<table>` when you need to scan or aggregate multiple rows.

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

---

### `<Task>`

A single task node.

- With `agent` prop: children is a prompt string, Smithers calls the agent
- Without `agent`: children is the output object directly

```tsx
// Agent task - prompt string
<Task id="analyze" output={schema.analyze} agent={codeAgent}>
  {`Analyze: ${ctx.input.description}`}
</Task>

// Hardcoded task - output directly
<Task id="setup" output={schema.setup}>
  {{ files: fs.readdirSync("./src") }}
</Task>
```

| Prop             | Type      | Description                                     |
| ---------------- | --------- | ----------------------------------------------- | ---------------------------------------------- |
| `id`             | `string`  | Stable identity seed for NodeId (optional)      |
| `output`         | `Table`   | Drizzle table from schema (e.g. schema.analyze) |
| `agent`          | `Agent`   | AI SDK agent (if provided, children → prompt)   |
| `skipIf`         | `boolean` | Skip if true                                    |
| `needsApproval`  | `boolean` | Require human approval                          |
| `timeout`        | `number`  | Max duration in ms before failing               |
| `retries`        | `number`  | Retry count on failure (default: 0)             |
| `continueOnFail` | `boolean` | Continue workflow if task fails                 |
| `children`       | `string   | Output`                                         | Prompt string (with agent) or output (without) |

When rendering arrays or loops, use React `key` on `<Task>` or its wrapper to keep NodeId stable.

---

### `<Sequence>`

Execute children one after another.

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

### Programmatic

```tsx
import { compileGraph, runGraph } from "smithers";
import workflow, { db } from "./workflow";

const graph = compileGraph(workflow, { db });

const results = await runGraph(graph, {
  input: { description: "Fix bugs" },
  onProgress: (event) => console.log(event.type, event.node),
});
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
