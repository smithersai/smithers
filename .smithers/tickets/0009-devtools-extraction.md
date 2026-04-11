# Extract Renderer-Agnostic DevTools Core

## Problem

`packages/react/src/devtools/SmithersDevTools.ts` is a 671-line file in the React package. It currently mixes renderer-specific instrumentation with renderer-agnostic DevTools state:

- React renderer instrumentation through `bippy`, including `instrument`, `secure`, `installRDTHook`, `traverseFiber`, fiber display names, host/composite checks, and fiber ids.
- Smithers DevTools data modeling, including `DevToolsNode`, `SmithersNodeType`, `DevToolsSnapshot`, `TaskExecutionState`, and `RunExecutionState`.
- State and view-model logic, including Smithers host tag mapping, serializable prop extraction, task metadata extraction, fiber-to-node conversion, snapshot counting, pretty printing, task lookup, EventBus attachment, run/task state aggregation, retries, waits, tool-call tracking, and cleanup.

This makes the DevTools model effectively React-owned even though most of the data structures, snapshot utilities, and execution tracking are not React-specific. The parts that genuinely require React are the bippy hook setup and the conversion from a React Fiber root into a `DevToolsNode` tree.

## Current State

Related files:

- `packages/react/src/devtools/index.ts` re-exports `SmithersDevTools` and its public types from the monolithic file.
- `packages/react/src/devtools/preload.ts` installs the React DevTools global hook through `bippy`.
- `packages/react/tests/devtools.test.ts` verifies bippy interception, Fiber-to-Smithers mapping, task metadata extraction, snapshot counts, tree printing, EventBus execution tracking, retries, approvals, and frame tracking.
- `packages/react-reconciler/src/reconciler/index.ts` also installs the React DevTools hook through `bippy`.

## Goal

Extract the reusable DevTools core into a renderer-agnostic location:

- Preferred option: create a new `packages/devtools` workspace package exported as `@smithers/devtools`.
- Acceptable option: add a renderer-agnostic `devtools` module under `packages/core` if the project wants to avoid a new package.

The extracted core must not import React, `react-reconciler`, or `bippy`. It should own the stable DevTools types, tree utilities, and state-tracking logic that can be shared by React, DOM, CLI, server, time-travel, or future renderers.

The React package should remain responsible only for React-specific instrumentation:

- Installing or using the React DevTools global hook.
- Listening to bippy commit and unmount callbacks.
- Traversing Fiber roots.
- Translating React Fibers and Smithers host tags into renderer-neutral `DevToolsNode` snapshots.
- Preserving the existing `SmithersDevTools` public API for React users.

## Proposed Changes

Move these pieces into the renderer-agnostic module:

- Public model types:
  - `SmithersNodeType`
  - `DevToolsNode`
  - `DevToolsSnapshot`
  - `DevToolsEventHandler`
  - `TaskExecutionState`
  - `RunExecutionState`
- Snapshot and tree helpers:
  - `countNodes`
  - `buildSnapshot`
  - `printTree`
  - `findNodeById`
  - `collectTasks`
- Execution state tracking:
  - run/task store creation
  - `getRun`
  - `getTaskState`
  - event ingestion logic currently in `_processEngineEvent`
  - EventBus-neutral attach/detach helpers, or a small adapter interface for buses that expose `on("event", handler)` and `removeListener("event", handler)`
- Shared constants that describe Smithers concepts rather than React internals, such as the `SmithersNodeType` set and optional display metadata used by `printTree`.

Keep these pieces in the React adapter:

- All `bippy` imports.
- `installRDTHook` usage.
- `instrument(secure(...))`.
- React DevTools hook preservation and cleanup.
- Fiber traversal.
- Fiber id assignment.
- Fiber display-name lookup.
- Host-fiber detection.
- `HOST_TAG_MAP` and `resolveNodeType` if the mapping remains tied to React host tags.
- `extractSerializableProps`, `extractTaskInfo`, and `fiberToNode` unless they are generalized to accept renderer-neutral host nodes or raw Smithers host props.

## Migration Path

1. Create the renderer-agnostic destination.
   - If using `packages/devtools`, add `package.json`, `tsconfig.json`, `src/index.ts`, and workspace dependency wiring.
   - If using `packages/core`, add `packages/core/src/devtools/index.ts` and export it from `packages/core/src/index.ts` only if that matches the package's public API conventions.

2. Move stable data models first.
   - Move the public DevTools types into the new module.
   - Update `packages/react/src/devtools/index.ts` and `SmithersDevTools.ts` imports to consume those types from the new location.
   - Keep type names and field shapes unchanged.

3. Extract tree utilities.
   - Move `countNodes`, `buildSnapshot`, `printTree`, `findNodeById`, and `collectTasks`.
   - Keep the React adapter responsible for producing a `DevToolsNode | null`; the core should only build snapshots and query/format renderer-neutral trees.

4. Extract execution state tracking.
   - Introduce a small class or factory, for example `DevToolsRunStore`, that owns the run map and event processing logic.
   - Move `_ensureRun`, `_ensureTask`, `_processEngineEvent`, `getRun`, `runs`, and `getTaskState` into that store.
   - Keep `SmithersDevTools.attachEventBus()` as an adapter method that forwards events into the store and preserves listener cleanup.

5. Rebuild `SmithersDevTools` as a React adapter.
   - Keep `start()` and `stop()` in the React package.
   - Keep bippy hook setup, previous hook restoration, Fiber traversal, and Fiber-to-node conversion in the React package.
   - On commit, call the extracted `buildSnapshot()` and store the latest snapshot.
   - Delegate run/task state APIs to the extracted run store.

6. Update package wiring.
   - Add the new dependency to `packages/react/package.json` if `packages/devtools` is created.
   - Ensure exports expose the new package or module path.
   - If the extraction reveals the React package imports `bippy` without declaring it directly, make the dependency explicit where needed.

7. Move and add tests.
   - Add renderer-agnostic tests for event processing and tree helpers in the chosen package.
   - Leave bippy/Fiber integration tests in `packages/react/tests/devtools.test.ts`.
   - Update imports in tests to match the new module layout.

8. Verify behavior.
   - Run the new package tests.
   - Run `bun test packages/react/tests/devtools.test.ts`.
   - Run typecheck for affected packages.

## Touch Points

- `packages/react/src/devtools/SmithersDevTools.ts`
- `packages/react/src/devtools/index.ts`
- `packages/react/src/devtools/preload.ts`
- `packages/react/tests/devtools.test.ts`
- `packages/react/package.json`
- `packages/core/src/index.ts` if the core package is chosen
- `packages/core/package.json` if the core package is chosen
- `packages/devtools/...` if a new package is chosen
- root workspace/package export configuration if a new package is chosen

## Dependencies

- None

## Acceptance Criteria

- A renderer-agnostic DevTools module exists in either `packages/devtools` or `packages/core/src/devtools`.
- The renderer-agnostic module exports the shared DevTools types and state utilities needed by non-React consumers.
- The renderer-agnostic module has no imports from `react`, `react-dom`, `react-reconciler`, `bippy`, or React type packages.
- `packages/react/src/devtools/SmithersDevTools.ts` is reduced to a React adapter that composes the extracted core with bippy/Fiber instrumentation.
- The existing React public API remains compatible:
  - `new SmithersDevTools(options).start()`
  - `stop()`
  - `attachEventBus(bus)`
  - `getRun(runId)`
  - `runs`
  - `getTaskState(runId, nodeId, iteration?)`
  - `snapshot`
  - `tree`
  - `printTree()`
  - `findTask(nodeId)`
  - `listTasks()`
- Existing exports from `packages/react/src/devtools/index.ts` continue to work, either by re-exporting the adapter and core types or by preserving type aliases.
- Event processing behavior is unchanged for `RunStarted`, `RunFinished`, `RunFailed`, `RunCancelled`, `FrameCommitted`, `NodePending`, `NodeStarted`, `NodeFinished`, `NodeFailed`, `NodeCancelled`, `NodeSkipped`, `NodeRetrying`, `NodeWaitingApproval`, `NodeWaitingEvent`, `NodeWaitingTimer`, `ToolCallStarted`, and `ToolCallFinished`.
- Tree behavior is unchanged for snapshot counts, task lookup, task listing, and `printTree()` output.
- Package manifests, workspace exports, and TypeScript configs are updated for the chosen location.
- Dependency ownership is explicit: `bippy` remains only in packages that actually import it, and the new renderer-agnostic module does not acquire it transitively.
- Unit tests cover the extracted run/task event tracking without rendering React.
- Existing React DevTools tests continue to pass after the extraction.

## Non-Goals

- Do not replace bippy or change how React commits are intercepted.
- Do not redesign the DevTools UI or output format.
- Do not change Smithers host tag names or task metadata field names.
- Do not change EventBus event shapes.
- Do not introduce React dependencies into `packages/core` or the new `packages/devtools` package.
