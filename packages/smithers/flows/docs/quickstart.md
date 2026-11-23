---
title: "Quickstart"
description: "Hands-on SDK tutorial: build a durable TypeScript flow on local SQLite, enforce a capability rule, and prove journal replay by editing a file between runs."
sidebar:
  order: 2
---

In five minutes you will write a single TypeScript file, run it straight on Node (zero build step), watch it read a file through a capability-guarded step into SQLite, and then **edit the file on disk and rerun** to prove the second run answers straight from the journal.

```text
+---------------------------------------------------------------+
| 1. Declaration (pure data)  Action.make + Flow.make           |
+---------------------------------------------------------------+
| 2. Implementation (Effect)  ReadNote.toLayer + Interpreter    |
+---------------------------------------------------------------+
| 3. Permission rule          allow fs:read on workspace/**     |
+---------------------------------------------------------------+
| 4. Durable host             NodeRuntime.layerHost (SQLite)    |
+---------------------------------------------------------------+
         |                                      |
   Run 1 (executionId: "quickstart-1")    Run 2 (same executionId)
   Reads workspace/note.txt -> records    Hits journal -> skips read
```

## 1. Create the project

Require **Node.js 22.19.0 or later** (Node strips TypeScript annotations natively, so no compiler or loader flag is needed). Jujutsu is not required for this walkthrough; see [Installation](./installation.md#requirements) when adding compensable steps or time-travel forks.

```bash
mkdir flows-quickstart && cd flows-quickstart
npm init -y && npm pkg set type=module
npm install @smthrs/platform-node@1.0.0-rc.16 @smthrs/flows@1.0.0-rc.16 effect@4.0.5
mkdir -p workspace && echo "the note" > workspace/note.txt
```

Why these three packages?

- `@smthrs/flows`: the platform-independent engine and authoring APIs (imports no `node:*` code). In published `1.0.0-rc.16`, `NodeRuntime` is imported from `@smthrs/flows/NodeRuntime`.
- `@smthrs/platform-node`: the Node host and SQLite driver.
- `effect@4.0.5`: imported directly by your code (the published `rc.16` cohort requires `effect@4.0.5`).

> **Using pnpm 11?** Replace `npm install` with `pnpm add @smthrs/platform-node@1.0.0-rc.16 @smthrs/flows@1.0.0-rc.16 effect@4.0.5` and run `pnpm approve-builds esbuild`. pnpm 11 holds dist-tags behind a 24-hour maturity window and requires approving `esbuild`'s install script (used by `@smthrs/platform-node` for sandboxed bundles). See [Installation](./installation.md).

## 2. Declare the action and flow (pure data)

An **action** is one recorded operation described only by its name and schemas. A **flow** wires actions into a step graph compiled before anything executes.

Start `quickstart.ts`:

```ts
import { Action, Capability, Flow, Interpreter } from "@smthrs/flows"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { resolve } from "node:path"

const workspaceRoot = resolve("workspace")

/** One recorded step: pure contract, no implementation yet. */
export const ReadNote = Action.make("quickstart/ReadNote", {
  payload: { path: Schema.String },
  success: Schema.String
})

/** The flow: compiles a graph of one action before anything runs. */
export const ReadNoteFlow = Flow.make("quickstart/ReadNoteFlow", {
  payload: { path: Schema.String },
  success: Schema.String,
  body: (payload) => ReadNote.call(payload)
})
```

## 3. Attach the implementation as an Effect layer

Separating declaration from implementation lets the engine plan, inspect, and cache steps without running user code. Inside the layer, ask for Effect's `FileSystem` service so the host's capability kernel can mediate every read:

```ts
const implementation = ReadNote.toLayer(({ path }) =>
  Effect.gen(function*() {
    const files = yield* FileSystem.FileSystem
    return yield* Effect.orDie(files.readFileString(`${workspaceRoot}/${path}`))
  })
)

/** Register implementations first, then the flow interpreter. */
const flows = Interpreter.layer(ReadNoteFlow).pipe(
  Layer.provideMerge(implementation),
  Layer.provideMerge(Action.layerImplementations)
)
```

## 4. Grant the exact capability required

An unattended host defaults to **deny all**: any capability without an explicit allow rule is refused rather than prompted. Grant `fs:read` strictly under `workspaceRoot`:

```ts
const allowWorkspaceReads = new Capability.Permission.Rule({
  effect: "allow",
  pattern: new Capability.Capability.CapabilityPattern({
    action: "fs:read",
    resource: `${workspaceRoot}/**`
  })
})
```

> **What does the kernel guard, and what does it not?**
> Capability rules guard the injected Effect services (`FileSystem`, `ChildProcessSpawner`, `HttpClient`, `Jj`). They are **not** an OS sandbox: code that bypasses Effect to call `node:fs` or global `fetch` escapes the grant store. To isolate untrusted code, execute it as a containerized child flow via `SandboxedFlow`; see [Run a child flow in a sandbox](./guides/run-a-child-flow-in-a-sandbox.md).

## 5. Stand up the host and run

`NodeRuntime.layerHost` wires the entire durable runtime in one call: creates `.flows/`, runs SQLite migrations, installs the capability kernel, sets up the artifact store and liveness probe, attaches `SIGINT`/`SIGTERM` shutdown hooks, and registers your flows last (so no persisted run resumes before its flow is loaded).

Append this to `quickstart.ts` (this targets published `1.0.0-rc.16`, where `NodeRuntime` lives at `@smthrs/flows/NodeRuntime`):

```ts
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"

const host = NodeRuntime.layerHost(
  {
    filename: `${workspaceRoot}/.flows/engine.db`,
    workspaceRoot,
    owner: { hostId: "quickstart" },
    rules: [allowWorkspaceReads]
  },
  flows
)

export const main = ReadNoteFlow.execute(
  { path: "note.txt" },
  { executionId: "quickstart-1" }
).pipe(
  Effect.provide(host),
  Effect.scoped
)

console.log(await Effect.runPromise(main))
```

Run it directly with Node:

```bash
node quickstart.ts
```

```text
the note
```

## 6. Two experiments to prove it is really durable

### Experiment A: Mutate the file and rerun

Overwrite `workspace/note.txt` with different text, then run `node quickstart.ts` again with the **same** `executionId` (`quickstart-1`):

```bash
echo "changed on disk" > workspace/note.txt
node quickstart.ts
```

It still prints `the note`. The action never ran a second time: `executionId` identifies one durable execution, and a completed execution replays straight from the SQLite journal. Change `executionId` to `"quickstart-2"` to read `"changed on disk"`.

### Experiment B: Drop the permission rule

Pass `rules: []` and run under a fresh `executionId` (such as `"quickstart-3"`). Because the implementation wrapped `readFileString` in `Effect.orDie`, the kernel refuses the read and halts with:

```console
Error [PlatformError]: PermissionDenied: FileSystem.read (<path>): permission_required: fs:read:<path> (tier sealed, request permission-1)
```

Note that a failed execution is recorded too. After restoring `allowWorkspaceReads`, use a new `executionId` (or delete `workspace/.flows`) to run cleanly. If an action should treat a denial as a normal return value rather than a defect, catch the error inside `toLayer` instead of calling `Effect.orDie`.

> **There are no dumb questions**
>
> **Q: What happens if I press `Ctrl-C` or `kill -9` halfway through a long flow?**
> A: On `Ctrl-C` (`SIGINT`/`SIGTERM`), `layerHost` closes its scope cleanly, marks the run `released`, prints `Error: All fibers interrupted without error`, and exits `1`; the next launch reclaims and resumes it immediately. On `kill -9`, the next launch on the same machine inspects the process table, sees the dead PID behind the lease, and reclaims it immediately (a run held by another `hostId` waits and logs why).
>
> **Q: What if I edit the flow code before resuming an incomplete execution?**
> A: Resuming an existing execution with a modified plan refuses with `plan_changed`; start a new `executionId` for the new plan. Wrap callbacks with [`Node.capture`](../core/docs/concepts/identity.md) to give closed-over values stable identities across restarts, and read [Change a flow and keep the work](./guides/change-a-flow-and-keep-the-work.md) to reuse completed steps across edits.

## Next steps

- Understand the plan, step keys, and safe cache reuse: [How Smithers Flows works](./concepts/how-it-works.md).
- Edit a flow and rerun only the changed steps: [Change a flow and keep the work](./guides/change-a-flow-and-keep-the-work.md).
- Pick the right Node runtime entry point and graceful shutdown policy: [Stand up a durable Node runtime](./guides/stand-up-a-node-runtime.md) and [Shut a host down](./guides/shut-a-host-down.md).
- Inspect plans, diff plans, and time-travel: [Inspect the plan](../flow/docs/guides/inspect-the-plan.md), [Diff two plans](../plan/docs/guides/diff-two-plans.md), [Rewind a run](../time-travel/docs/guides/rewind-a-run.md).
- Isolate untrusted step code: [Run a child flow in a sandbox](./guides/run-a-child-flow-in-a-sandbox.md).
- Look up every runtime refusal: [Troubleshooting](./troubleshooting.md).
