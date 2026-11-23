# How durable flows work

> Why Smithers plans a flow before running it, identifies steps by their inputs, and enforces capabilities at the host boundary.

An agent run is not a shell script. It calls models that cost money, edits files on disk, waits for humans, and occasionally crashes halfway through. Making those runs reliable requires three things: a plan you can inspect before anything runs, a cache you can trust when you rerun, and a record you can resume after a crash.

Smithers gets all three from two design choices:

1. **A flow is planned before it runs.**
2. **A step is identified by what it reads, not where it sits.**

```text
PHASE 1: PLAN (pure, zero side effects)        PHASE 2: EXECUTE (content-addressed)
+------------------------------+               +----------------------------------------+
| Plan(issue) -> placeholder   |               | Step Key = SHA-256(                    |
|      |                       |               |   payload + prior outputs +            |
|      v                       |  approved     |   file boundary + env +                |
| Test(plan)  -> placeholder   | ----------->  |   implementationVersion                |
|      |                       |   plan        | )                                      |
|      v                       |               |   |-- HIT  -> Replay from SQLite       |
| Report(res) -> dry-run graph |               |   +-- MISS -> Run guarded host & store |
+------------------------------+               +----------------------------------------+
```

_Two-phase execution: Phase 1 builds a pure step graph from placeholders; Phase 2 hashes each step's declared inputs and replays hits from SQLite or runs misses through the capability kernel_

## Phase 1: A flow is a plan

A flow declares its input schema, output schema, capabilities, and `body`. When you invoke `body`, it does **not** call a model or touch the filesystem. It executes once in memory and returns a pure step graph: which actions exist, what data flows between them, and which branches or fan-outs are possible.

```ts
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

export default Flow.make("greet", {
  description: "Return a greeting",
  capabilities: [],
  effects: [],
  payload: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  body: Node.capture({}, ({ name }) => Node.succeed(`Hello, ${name}`))
})
```

Inside `body`, the return value of an earlier step is a **placeholder**, not a live JavaScript value. You can pass a placeholder into the next step's payload, transform it with `Node.map`, or branch on it with `Node.branch`. Trying to compute with a placeholder directly (such as `JSON.stringify` or string concatenation) fails at plan time before a single side effect occurs.

Because the plan is data:
- You can inspect it with `smthrs flow plan greet name=World` without spending a token or writing a file.
- A person can review the exact capability envelope and approve or deny the plan before execution begins.
- A plan is append-only: completed steps are never rewritten in place.

## Phase 2: Content-addressed step keys

When the engine reaches a step at run time, it computes a deterministic SHA-256 **step key** from what the step declares can affect its result:

- Its input payload and the concrete outputs it consumes from upstream steps.
- Its declared file boundary (the paths it is allowed to read).
- Its declared environment, tools, and capabilities.
- Its `implementationVersion` string (bump this when you change the step's code).

Notice what is **not** in the key: the step's line number or order in the flow.

When the engine looks up that key in SQLite:
- **Cache hit:** the engine returns the recorded output immediately and skips running the step.
- **Cache miss:** the engine runs the step through the guarded host, persists the result under that key, and advances the graph.

### What reruns when something changes

Consider a three-step flow (`Plan -> Test -> Report`):

| Event | `Plan` | `Test` | `Report` | Steps executed |
| --- | --- | --- | --- | --- |
| Process killed after `Plan`, then resumed | Reused | Ran | Ran | 2 of 3 |
| New step appended at the end | Reused | Reused | Ran | 1 of 3 |
| `Test` edited (`implementationVersion` bumped), same output | Reused | Ran | Reused | 1 of 3 |
| `Plan` reran and produced identical bytes | Ran | Reused | Reused | 1 of 3 |
| Flow input changed | Ran | Ran | Ran | 3 of 3 |

Look at rows 3 and 4. Because downstream keys hash the **actual output bytes** of upstream steps, a step that reruns and produces the same output still lets every downstream step hit the cache.

## Why you can edit a flow without replay versioning

Traditional replay engines record an ordered log of every call a workflow made and expect the code to make the exact same calls in the exact same order on restart. Editing the workflow breaks replay unless you maintain manual version branches (`if (version >= 2)`).

Smithers matches steps by content key rather than call order. When you edit a flow and bump a step's `implementationVersion`, unchanged upstream steps keep their keys and replay from the journal, while the changed step and any downstream step whose inputs changed run cleanly.

## Capabilities and the host boundary

Steps never call raw OS APIs directly. They call Effect services injected by the host (`FileSystem`, `ChildProcessSpawner`, `HttpClient`, `Jj`), wrapped in Smithers' capability kernel:

| Capability prefix | Governs | Example |
| --- | --- | --- |
| `fs:read:` | File and directory reads | `fs:read:**` |
| `fs:write:` | File writes and mutations | `fs:write:src/**` |
| `proc:spawn:` | Child process execution | `proc:spawn:*` |
| `model:call:` | LLM calls through a configured seat | `model:call:*` |

In an unattended host, any capability not explicitly granted is denied with `permission_required` naming the exact resource requested. To isolate untrusted code that might bypass Effect services (for example calling `node:fs` directly), run it as a sandboxed child flow in a container.

## Next steps

- Discover, override, pin, and draft-test flows in your repository: [Flows reference](https://smithers.sh/docs/flows/).
- Run a local coding flow end to end: [Run agents on your Mac](https://smithers.sh/docs/local-quickstart/).
- Browse the `@smthrs/*` runtime packages: [Library API](https://smithers.sh/docs/reference/api/).
