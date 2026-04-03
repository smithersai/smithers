You are designing Smithers DevTools — developer tools for the Smithers workflow orchestration framework. Smithers uses React as a "compiler" (not for UI) with a custom react-reconciler to build execution DAGs from JSX.

## Context loading

Before asking any questions, read these files to understand the prototype and the product:

### 1. Read the devtools prototype (what exists so far)

Read these files in order:
- `src/devtools/SmithersDevTools.ts` — the main devtools class (Bippy-based fiber inspection + EventBus state tracking)
- `src/devtools/index.ts` — public exports
- `src/devtools/preload.ts` — Bun preload for hook installation
- `tests/devtools.test.ts` — 11 tests proving the hard parts work

### 2. Read the renderer and engine to understand the execution model

- `src/dom/renderer.ts` — custom react-reconciler (renders to HostElement tree, not DOM)
- `src/dom/extract.ts` — walks HostElement tree → TaskDescriptor[]
- `src/engine/scheduler.ts` — PlanNode tree, task state machine, scheduling
- `src/SmithersEvent.ts` — all event types the engine emits
- `src/events.ts` — EventBus implementation
- `src/TaskDescriptor.ts` — what a task looks like after extraction
- `src/components/Task.ts` — how JSX Task maps to smithers:task host elements
- `src/components/index.ts` — all component types

### 3. Read the user-facing docs to understand how users think about Smithers

Read all files in `docs/` — focus on:
- What workflows look like from a user's perspective
- The TOON format (declarative alternative to JSX)
- How users define agents, tasks, sequences, loops, approvals
- The CLI commands (run, resume, list, approve, status)
- Any existing observability/debugging docs

## What the prototype proved

The POC validated these hard/uncertain parts:

1. **Bippy can intercept Smithers' custom reconciler** — react-reconciler calls `__REACT_DEVTOOLS_GLOBAL_HOOK__` automatically; we added `injectIntoDevTools()` to the renderer
2. **Fiber tree maps to Smithers concepts** — host fibers (`smithers:workflow`, `smithers:task`, etc.) carry full props including `__smithersKind`, agent refs, labels
3. **Task metadata is extractable** from `memoizedProps` on host fibers (nodeId, kind, agent chain, label, output)
4. **Multi-commit tracking works** — each `renderer.render()` triggers a new fiber commit, so the devtools see every re-render
5. **EventBus integration works** — attaching to the engine's EventBus gives real-time task execution state (started, finished, failed, retrying, waiting-approval, tool calls, frame commits)
6. **Import ordering constraint**: `installRDTHook()` must run before react-reconciler is first imported (solved via Bun preload or dynamic imports)

## Your task

Ask the user one question at a time (at least 10 total) to design the full Smithers DevTools. Wait for their answer before asking the next question. Each question should be specific and help resolve a concrete design decision. Don't ask vague questions — propose 2-3 concrete options where possible so the user can react to something tangible.

The questions should cover areas like:
- Primary use cases and user personas (who needs this, what are they trying to debug)
- Delivery surface (CLI output, TUI, web UI, Chrome extension, VS Code panel, etc.)
- What information matters most during a running workflow vs. post-mortem
- How devtools interact with the existing CLI, hot reload, and approval flows
- TOON workflows vs JSX workflows — do they need different treatment
- The relationship between the React fiber tree view and the Smithers execution view
- Whether this should be opt-in (separate package) or built into the core
- Performance budget and production safety
- Integration with existing observability (OpenTelemetry, Prometheus metrics)
- What "time travel" or replay would mean for a workflow engine
