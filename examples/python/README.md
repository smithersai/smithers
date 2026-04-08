# Python Workflows for Smithers

Write Smithers workflows in Python using a builder pattern that maps 1:1 to the JSX API. Define output types as Pydantic models — they're automatically converted to Zod schemas on the TS side.

Agents are defined in TypeScript. Everything else — schemas, workflow logic, prompts — lives in Python.

## Quick start

```bash
# Prerequisites
brew install uv  # or: curl -LsSf https://astral.sh/uv/install.sh | sh

# Run an example
bun run examples/python/run-simple-workflow.ts
```

## How it works

A Python workflow is two files:

**1. Python script** — defines schemas, workflow logic, and prompts:

```python
# workflow.py
from pydantic import BaseModel
from smithers import workflow, task, sequence, run

class Research(BaseModel):
    summary: str
    key_points: list[str]

class Article(BaseModel):
    content: str
    word_count: int

SCHEMAS = {"research": Research, "article": Article}

def build(ctx):
    topic = ctx.input.get("topic", "AI")
    research = ctx.output_maybe("research", "research")

    return workflow("my-workflow",
        sequence(
            task("research", output="research", agent="claude",
                 prompt=f"Research {topic}"),
            task("write", output="article", agent="claude",
                 depends_on=["research"],
                 prompt=f"Write about: {research['summary']}" if research else ""),
        ),
    )

if __name__ == "__main__":
    run(build, schemas=SCHEMAS)
```

**2. TypeScript runner** — provides agents and runs the workflow:

```typescript
// run.ts
import { createPythonWorkflow, runWorkflow } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const workflow = createPythonWorkflow({
  scriptPath: "./workflow.py",
  agents: {
    claude: new Agent({ model: anthropic("claude-sonnet-4-20250514") }),
  },
  // schemas auto-discovered from Pydantic models!
});

const result = await runWorkflow(workflow, {
  input: { topic: "AI orchestration" },
});
```

No Zod schemas needed in TypeScript — they're generated from your Pydantic models automatically.

## Pydantic schemas

Define output types as Pydantic `BaseModel` classes and pass them to `run()`:

```python
from pydantic import BaseModel

class Analysis(BaseModel):
    summary: str
    issues: list[str]
    severity: str  # use str for enums
    notes: str | None = None  # Optional → nullable column

SCHEMAS = {"analysis": Analysis}

if __name__ == "__main__":
    run(build, schemas=SCHEMAS)
```

The schema names in `SCHEMAS` must match the `output=` strings used in your tasks.

### Type mapping

| Python / Pydantic | JSON Schema | Zod | SQLite |
|-------------------|-------------|-----|--------|
| `str` | `string` | `z.string()` | TEXT |
| `int` | `integer` | `z.number().int()` | INTEGER |
| `bool` | `boolean` | `z.boolean()` | INTEGER |
| `float` | `number` | `z.number()` | INTEGER* |
| `list[str]` | `array` | `z.array(z.string())` | TEXT (JSON) |
| `dict` / nested `BaseModel` | `object` | `z.object({...})` | TEXT (JSON) |
| `str \| None` | `anyOf + null` | `z.string().nullable()` | TEXT (nullable) |

*SQLite stores all numbers as INTEGER. Use `int` for numeric fields.

### Without Pydantic

You can still pass Zod schemas explicitly from TypeScript:

```typescript
const workflow = createPythonWorkflow({
  scriptPath: "./workflow.py",
  schemas: { analysis: z.object({ summary: z.string() }) },
  agents: { claude },
});
```

## Python API

### Node builders

#### `workflow(name, *children)`

Root node. Every build function must return one.

#### `task(id, *, output, agent=None, prompt=None, payload=None, ...)`

A single executable unit.

```python
# Agent mode — calls an AI model
task("analyze", output="analysis", agent="claude",
     prompt="Analyze this code")

# Static mode — writes a literal value
task("config", output="config",
     payload={"env": "production"})
```

Options: `depends_on`, `needs`, `retries`, `timeout_ms`, `skip_if`, `continue_on_fail`, `needs_approval`, `label`, `meta`.

#### `sequence(*children)`

Run children one after another.

#### `parallel(*children, max_concurrency=None)`

Run children concurrently.

#### `loop(id, *, until, children, max_iterations=None)`

Repeat until condition is met. `until` is re-evaluated each render cycle.

```python
def build(ctx):
    approved = ctx.latest("review", "review") is not None \
        and ctx.latest("review", "review").get("approved", False)

    return workflow("review-loop",
        loop("review", until=approved, max_iterations=5,
             children=task("review", output="review", agent="reviewer",
                          prompt="Review the code")),
    )
```

### Context (`Ctx`)

```python
ctx.run_id          # str
ctx.iteration       # int
ctx.input           # dict

ctx.outputs("table")                    # list[dict]
ctx.output("table", "nodeId")           # dict (raises KeyError)
ctx.output_maybe("table", "nodeId")     # dict | None
ctx.latest("table", "nodeId")           # dict | None (highest iteration)
ctx.iteration_count("table", "nodeId")  # int
```

### Runner

```python
from smithers import run

if __name__ == "__main__":
    run(build, schemas=SCHEMAS)
```

## TypeScript API

### `createPythonWorkflow(config)`

```typescript
const workflow = createPythonWorkflow({
  scriptPath: "./workflow.py",    // Path to Python script
  agents: { ... },                // Agent registry: name → AgentLike
  // Optional:
  schemas: { ... },               // Zod schemas (skip for auto-discovery)
  dbPath: "./smithers.db",
  cwd: ".",
  timeoutMs: 30000,
  env: { PYTHONPATH: "..." },
});
```

### `createExternalSmithers(config)`

Lower-level API for any language, not just Python:

```typescript
const workflow = createExternalSmithers({
  schemas: { ... },  // Zod schemas (required)
  agents: { ... },
  buildFn: (ctx) => myCustomBuilder(ctx),  // Returns HostNodeJson
});
```

## Examples

| Example | Pattern | File |
|---------|---------|------|
| Simple Workflow | Sequence of two agents | `simple_workflow.py` |
| Fan-Out Fan-In | Split → parallel → merge | `fan_out_fan_in.py` |
| Code Review Loop | Iterative fix → review | `code_review_loop.py` |
| Debate | Parallel argumentation + judge | `debate.py` |
| Gate | Poll until ready | `gate.py` |
| ETL Pipeline | Extract → transform → load | `etl.py` |

Run any example: `bun run examples/python/run-<name>.ts`

## Architecture

```
┌──────────────────┐                              ┌─────────────────┐
│  Smithers Engine  │  1. uv run script --schemas  │  Python Script  │
│  (TypeScript)     │ ─────────────────────────── → │  (Pydantic)     │
│                   │ ← JSON Schema definitions ── │                 │
│  Converts to Zod  │                              │                 │
│  Creates DB tables│  2. stdin: serialized ctx     │                 │
│                   │ ─────────────────────────── → │  build(ctx)     │
│  Schedules tasks  │ ← stdout: HostNode JSON ──── │  returns tree   │
│  Runs agents      │                              │                 │
│  Persists outputs │  (repeat for each render)     │                 │
└──────────────────┘                              └─────────────────┘
```
