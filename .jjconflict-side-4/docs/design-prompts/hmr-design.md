# Design Prompt: Hot Module Replacement for Smithers Workflows

## What is Smithers?

Smithers is a **workflow orchestration engine built on React**. Not React-DOM for browsers — it uses a **custom React reconciler** (`react-reconciler`) to render a JSX component tree into an XML-like structure that describes tasks to execute. Tasks are dispatched to AI agents (Claude, Codex, Gemini, etc.) that run in parallel.

**Key insight: Smithers IS React.** The workflow definition is a React component tree. The engine renders it with a real React reconciler. State lives in SQLite, not in the React fiber tree.

### Architecture overview

A user defines a workflow as a `.tsx` file that exports a React component tree:

```tsx
// plue/workflow/components/workflow.tsx — a real user workflow
export default smithers((ctx) => {
  return (
    <Workflow name="plue-slop-factory">
      <SuperRalph
        ctx={ctx}
        focuses={focuses}
        agents={{
          opus: {
            agent: new ClaudeCodeAgent({ 
              model: "claude-opus-4-6", 
              systemPrompt: PLANNING_PROMPT,  // ← a string constant, frozen at import time
            }),
          },
          codex: {
            agent: new CodexAgent({ 
              model: "gpt-5.3-codex", 
              systemPrompt: "Implement with TDD.",
            }),
          },
        }}
      />
    </Workflow>
  );
});
```

The workflow file imports things from other files — prompts, config, focus lists, etc.:

```ts
// These are all module-level constants, evaluated once at import() time
import { focuses } from "./focuses";           // list of work categories
import { getTarget } from "../targets";         // build/test commands, code style
import { WORKFLOW_MAX_CONCURRENCY } from "../config";  // concurrency limit

const PLANNING_PROMPT = `Plan and research. PRIORITY: ...`;  // prompt text
```

### The engine loop

The engine loads the workflow module once, then runs a `while(true)` loop. Each iteration:

1. Loads current state from SQLite (inputs, outputs, ralph iterations)
2. **Re-renders the React component tree** by calling `workflow.build(ctx)`
3. The custom reconciler diffs the tree and produces `TaskDescriptor[]`
4. The scheduler determines which tasks are runnable
5. Launches runnable tasks as agent subprocesses
6. Waits for at least one task to finish (`await Promise.race(inflight)`)
7. Loops back to step 1

Here is the actual engine loop (abbreviated):

```ts
// src/engine/index.ts — the main engine loop
const renderer = new SmithersRenderer();  // custom React reconciler

while (true) {
  // 1. Load current state
  const inputRow = await loadInput(db, inputTable, runId);
  const outputs = await loadOutputs(db, schema, runId);
  const ctx = buildContext({ runId, iteration, input: inputRow, outputs });

  // 2. Re-render the React tree — this calls the user's workflow function
  const { xml, tasks, mountedTaskIds } = await renderer.render(
    workflow.build(ctx),  // ← workflow.build is the user's (ctx) => <Workflow>...</Workflow>
    { ralphIterations, defaultIteration, baseRootDir: rootDir },
  );

  // 3-4. Build plan tree, compute task states, schedule
  const { plan, ralphs } = buildPlanTree(xml);
  const stateMap = await computeTaskStates(adapter, db, runId, tasks, ...);
  const schedule = scheduleTasks(plan, stateMap, descriptorMap, ralphState);
  const runnable = applyConcurrencyLimits(schedule.runnable, stateMap, maxConcurrency, tasks);

  if (runnable.length === 0 && inflight.size > 0) {
    // 6. Nothing new to launch — wait for an in-flight task to finish
    await Promise.race(inflight);
    continue;
  }

  // 5. Launch new tasks
  for (const task of runnable) {
    const p = executeTask(adapter, db, runId, task, ...).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  // 6. Wait for at least one to finish, then re-render
  await Promise.race(inflight);
}
```

### The custom React reconciler

Smithers uses `react-reconciler` to render JSX into a host tree of `HostElement`/`HostText` nodes, then extracts `TaskDescriptor[]` from it:

```ts
// src/dom/renderer.ts
import Reconciler from "react-reconciler";

const reconciler = Reconciler(hostConfig);  // standard react-reconciler with custom host config

export class SmithersRenderer {
  private container: HostContainer;
  private root: any;

  constructor() {
    this.container = { root: null };
    this.root = reconciler.createContainer(this.container, 0, null, false, ...);
  }

  async render(element: React.ReactElement, opts?: ExtractOptions) {
    reconciler.updateContainerSync(element, this.root, null, () => {});
    reconciler.flushSyncWork();
    return extractFromHost(this.container.root, opts);  // → { xml, tasks, mountedTaskIds }
  }
}
```

### The workflow type

```ts
// src/SmithersWorkflow.ts
export type SmithersWorkflow<Schema> = {
  db: unknown;                                                    // Drizzle SQLite DB
  build: (ctx: SmithersCtx<Schema>) => React.ReactElement;       // the render function
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  zodToKeyName?: Map<ZodObject<any>, string>;
};
```

### How workflows are loaded today

The CLI loads the workflow module exactly **once** via dynamic `import()`:

```ts
// src/cli/index.ts
async function loadWorkflow(path: string): Promise<SmithersWorkflow<any>> {
  const abs = resolve(process.cwd(), path);
  const mod = await import(pathToFileURL(abs).href);  // cached by Bun's module system forever
  if (!mod.default) throw new Error("Workflow must export default");
  return mod.default as SmithersWorkflow<any>;
}
```

And the engine receives the workflow object, using `workflow.build` on every loop iteration:

```ts
// src/cli/index.ts
const workflow = await loadWorkflow(workflowPath);  // loaded once
const result = await runWorkflow(workflow, { ... }); // passed into engine
```

### Where state lives

**All workflow state is in SQLite**, not in the React tree:
- Runs, attempts, frames, nodes, ralph iterations → `_smithers_*` tables
- Task outputs → user-defined Drizzle tables
- The React fiber tree is discarded after each render and rebuilt from scratch

This means there is **no React state to lose** during a hot reload. The reconciler is essentially stateless between renders (unlike browser React where component state lives in fibers).

### How consumers run workflows

A typical consumer (e.g., the `plue` project) has a runner script:

```ts
// plue/workflow/run.ts
const smithersCli = findSmithersCli();
await $`bun run ${smithersCli} run components/workflow.tsx --root ${ROOT_DIR} --max-concurrency 16`;
```

The dependency tree of a typical workflow looks like:

```
components/workflow.tsx          ← the root workflow component
  ├── ../smithers.ts             ← createSmithers() call, DB setup
  ├── ../config.ts               ← WORKFLOW_MAX_CONCURRENCY, TASK_RETRIES
  ├── ../targets.ts              ← build commands, test commands, code style
  ├── ./focuses.ts               ← list of work categories
  ├── ./focusDirs.ts             ← directory mappings
  ├── ./focusTestSuites.ts       ← test suite mappings
  ├── @smithers-orchestrator/super-ralph  ← smithers package (stable, not user code)
  └── smithers-orchestrator      ← smithers core (stable, not user code)
```

The user frequently wants to change:
- **Prompt strings** — the `PLANNING_PROMPT`, `TESTING_PROMPT` constants, or prompts that live in `.md`/`.mdx` files
- **Focus lists** — adding/removing/reprioritizing work categories in `focuses.ts`
- **Config values** — changing concurrency, retries in `config.ts`
- **Agent configuration** — changing models, timeouts, adding/removing agents
- **Component structure** — changing the JSX tree (adding tasks, reordering sequences)

Today, **none of these changes take effect until the entire process is killed and restarted** (or the run finishes and a new one starts). This is because `import()` caches the module and all its dependencies permanently.

---

## The Feature: Hot Module Replacement for Workflows

### What we want

When a user edits any file in their workflow's dependency tree and saves, the **running workflow should pick up the changes on the next render cycle** — without:
- Restarting the process
- Losing the current run state (which is in SQLite anyway)
- Interrupting in-flight tasks (they continue with their old prompts; only newly-scheduled tasks use new code)

This is exactly analogous to how **Vite + React Fast Refresh** works in a web app:
- Vite watches files → detects change → invalidates module graph → sends updated module to browser
- React Fast Refresh swaps component implementations in the fiber tree → reconciler re-renders → state preserved

**Smithers already has the React side of this.** The reconciler re-renders every loop iteration. State lives in SQLite, not fibers. What's missing is the **Vite dev server equivalent** — the file watching and module invalidation layer.

### How Vite/Bun HMR works (for reference)

Vite's HMR (and Bun's `import.meta.hot` which is compatible):

1. **File watcher** detects a change to `foo.ts`
2. **Module graph** is walked to find the HMR boundary (the nearest module that calls `import.meta.hot.accept()`)
3. The changed module (and anything between it and the boundary) is **re-evaluated** with a cache-busting query string (`?t=1234567890`)
4. The `accept()` callback receives the new module and swaps the relevant references
5. **React Fast Refresh** (a special case) automatically registers component updates so React can swap function implementations without losing state

Bun supports this same `import.meta.hot` API in `Bun.serve()` with `development: true`. However, Smithers is a **CLI process**, not a `Bun.serve()` server. So we need to implement the equivalent mechanism ourselves.

### Key design principle

**This is a feature of the Smithers engine, not the consumer.** The consumer shouldn't need to write `import.meta.hot.accept()` calls or any HMR-aware code. They just write normal `.tsx` workflow files and edit them. The engine handles everything.

### What needs to be designed

1. **File watching**: How do we discover and watch the workflow file's dependency tree? Options include:
   - `fs.watch` / `fs.watchFile` on known files
   - Bun's built-in file watching
   - `Bun.build()` to get the dependency graph, then watch all files in it
   - Walking `import` statements manually
   - Watching entire directories

2. **Module invalidation**: How do we make `import()` return fresh code? Options include:
   - Cache-busting query string: `import(path + '?t=' + Date.now())` (same technique Vite uses)
   - Bun-specific module cache APIs if they exist
   - Clearing `require.cache` (CJS only, may not work with ESM)

3. **Workflow hot-swap**: What parts of the `SmithersWorkflow` object can/should be swapped?
   - `workflow.build` — definitely yes, this is the render function
   - `workflow.db` — probably NOT, the DB connection should be preserved
   - `workflow.schemaRegistry` / `workflow.zodToKeyName` — need to think about this; schema changes mid-run could be dangerous
   - `workflow.opts` — maybe, but carefully

4. **Wake signal**: The engine loop currently blocks on `await Promise.race(inflight)` waiting for a task to finish. A file change should wake the loop immediately so it re-renders with the new code. This probably means adding a file-change promise to the `Promise.race` set.

5. **Safety boundaries**: What changes are safe to hot-reload vs. what should trigger a warning or require a restart?
   - Safe: prompt text, config values, focus lists, agent config, JSX tree structure
   - Unsafe: DB schema changes, output table changes, input table changes
   - Edge case: changing a task's `id` — the scheduler uses node IDs to track state; changing an ID effectively creates a "new" task and orphans the old one

6. **CLI interface**: How does the user opt in?
   - `smithers up workflow.tsx --hot true` flag?
   - `smithers dev workflow.tsx` command (like Vite's `vite dev`)?
   - Always-on in development?

7. **Consumer API surface**: Should there be any new APIs for consumers?
   - A way to read prompt files that are automatically watched? e.g., `useFile("./prompts/planning.md")`
   - Or is just re-importing the module enough?

8. **Scope of watched files**: The workflow imports smithers-orchestrator and super-ralph packages. These are **library code** and should NOT be watched (just like Vite doesn't watch `node_modules/`). Only the user's workflow files should be watched. How do we distinguish?

9. **Error handling**: What happens if the user saves a file with a syntax error?
   - The old workflow should keep running
   - The error should be reported (logged, shown in UI)
   - When the error is fixed and the file is saved again, the new code should be picked up

10. **Events/observability**: Should HMR events be part of the event bus?
    - `WorkflowReloaded` event with changed files list?
    - `WorkflowReloadFailed` event with error?

### Constraints

- This runs in Bun (not Node.js) — leverage Bun-specific APIs where beneficial
- The smithers engine code (`src/`) is the only thing that changes. Consumer workflow code should work as-is without modifications.
- Must not affect production behavior. HMR should be opt-in or dev-only.
- Must handle the case where the workflow file has side effects at module scope (e.g., `createSmithers()` creates a DB connection — we don't want to create a new DB connection on every reload)

### Deliverable

Please produce a detailed engineering design that covers:

1. **Architecture**: How the file watching, module invalidation, and hot-swap mechanism work together. Include a diagram.
2. **API design**: The CLI interface, any new `RunOptions`, any new consumer-facing APIs.
3. **Implementation plan**: Which files in `src/` need to change and how. Be specific about the changes to the engine loop, CLI, and any new modules.
4. **Safety model**: What changes are safe, what triggers warnings, what requires restart.
5. **Edge cases**: Syntax errors, schema changes, side effects, race conditions between file changes and in-flight tasks.
6. **Testing strategy**: How to test HMR behavior.
