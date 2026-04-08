# Smithers V2 — Engine redesign on Effect ecosystem

## Problem

Smithers uses `effect` core heavily but reimplements everything that
`@effect/workflow`, `@effect/cluster`, `@effect/rpc`, and `@effect/sql` already
provide. The result is ~3,700 lines of hand-rolled infrastructure duplicating
battle-tested Effect code: 15+ custom SQLite tables, a custom event bus, manual
retry/heartbeat logic, a monolithic 5,400-line engine, and a non-functional
sandbox transport layer.

### What we use today

```
effect               ✅ Effect, Metric, Layer, Queue, etc.
@effect/platform     ✅ HTTP, file system
@effect/platform-bun ✅ Bun runtime
@effect/opentelemetry ✅ Tracing
@effect/sql          ✅ declared in package.json but NOT imported in src/
```

### What we should use but don't

```
@effect/workflow     ❌ reimplemented — Workflow, Activity, DurableDeferred, DurableClock
@effect/cluster      ❌ reimplemented — Entity, Sharding, MessageStorage, Runner
@effect/rpc          ❌ reimplemented — RpcGroup, RpcServer, RpcClient
@effect/sql-sqlite-bun ❌ reimplemented — using drizzle-orm/bun-sqlite directly
```

### Architecture flaws this fixes

1. **No worker model** — `executeTask()` runs inline in the scheduler loop. No
   indirection, no dispatch, no concept of where a task runs.
2. **SQLite state as source of truth** — State scattered across 15 tables.
   Recovery reads current table values instead of replaying an ordered event log.
3. **No activity/workflow split** — Pure `computeFn` and side-effectful agent
   calls go through the same execution and retry path. No way to safely replay
   side effects.
4. **Synchronous scheduling** — `while(true) { render → executeTask → Promise.race }`
   blocks until at least one task finishes before re-scheduling.
5. **No workflow versioning** — Hot reload can change the task graph mid-run with
   no way to detect or handle divergence.
6. **Sandbox is a no-op** — All three transports (bubblewrap, Docker, Codeplane)
   are stubs. The fundamental `create/ship/execute/collect/cleanup` interface
   can't work because workflows are live JS closures that can't be serialized.

---

## Design Principles

1. **Parent is the ultimate source of truth.** If the parent doesn't know about
   a state transition, it never happened.
2. **Events are the log.** All state is derived from replaying events. SQLite
   stores the log, but the log is the truth.
3. **Workers are the default unit of execution.** Even the trivial local case is
   "a worker that happens to be this process."
4. **Side effects are explicit and stateless.** Their output is JSON + git diff.
   Replaying means reading the recorded output, not re-executing the effect.
5. **Reuse the Effect ecosystem.** Don't build what already exists.

---

## Part 1: Mapping Smithers → Effect ecosystem

### Persistence: `@effect/sql-sqlite-bun` replaces drizzle internals

| Smithers table | Effect replacement |
|---|---|
| `_smithers_events` | `MessageStorage` (persisted RPC message log) |
| `_smithers_runs` | Derived from `Workflow.Result` (Complete/Suspended) |
| `_smithers_nodes` | Derived from Activity execution state |
| `_smithers_attempts` | `Activity.CurrentAttempt` + persisted replies |
| `_smithers_approvals` | `DurableDeferred` |
| `_smithers_sandboxes` | Entity state in cluster |
| `_smithers_sandbox_events` | `MessageStorage` handles this |
| `_smithers_sandbox_diffs` | Persisted as part of Activity result |

User-defined output tables (via Zod→Drizzle) stay on drizzle — only internal
Smithers tables migrate. `SqlMessageStorage` from `@effect/cluster` handles
event/message persistence automatically.

### Workflows: `@effect/workflow` replaces engine internals

#### `Workflow.make()` wraps the React scheduler loop

```ts
// User-facing API is unchanged:
const workflow = smithers(({ ctx }) => (
  <Workflow name="my-workflow">
    <Task id="analyze" agent={myAgent} output={results}>Analyze</Task>
  </Workflow>
));

// Under the hood, smithers() creates an Effect Workflow:
const effectWorkflow = Workflow.make({
  name: "my-workflow",
  payload: Schema.Struct({ /* input schema */ }),
  success: Schema.Struct({ /* output schema */ }),
  idempotencyKey: (payload) => hash(payload),
});

// The React scheduler loop becomes the workflow body:
effectWorkflow.toLayer((payload, executionId) =>
  Effect.gen(function* () {
    const renderer = new SmithersRenderer();
    while (true) {
      // 1. Render JSX tree (deterministic)
      const { xml, tasks } = yield* Effect.sync(() =>
        renderer.render(workflowRef.build(ctx))
      );
      // 2. Schedule tasks (deterministic)
      const { runnable, finished } = scheduleTasks(plan, stateMap);
      if (finished) return outputs;
      // 3. Dispatch as Activities — memoized by workflow engine on replay
      const results = yield* Effect.all(
        runnable.map(task => taskToActivity(task)),
        { concurrency: maxConcurrency }
      );
      // 4. Apply results
      outputs = applyResults(outputs, results);
    }
  })
);
```

The React render step is deterministic — it depends only on `input` + `outputs`
(which come from completed activities). On replay, the workflow re-renders the
same JSX tree, discovers the same tasks, and the Activity layer returns cached
results. Only new tasks actually execute.

#### `Activity.make()` replaces `executeTask()`

Every `<Task>` compiles to an Activity:

```ts
// <Task id="analyze" agent={gpt4Agent} output={results}>Analyze</Task>
const analyzeActivity = Activity.make({
  name: "analyze",
  success: resultsSchema,
  error: SmithersTaskError,
  execute: Effect.gen(function* () {
    const result = yield* runAgent(gpt4Agent, "Analyze");
    return result;
  }),
});
```

Activities are automatically memoized by the workflow engine. On replay,
`Activity.make()` returns the cached result without re-executing. This replaces
the manual "check node state → skip if finished" logic.

#### Side-effect split via Activity

```tsx
// Pure task — runs inline in orchestrator, no Activity wrapper needed
<Task id="compute" computeFn={(ctx) => transform(ctx)} output={results} />
// → Direct function call, result persisted as workflow state

// Side-effect task — wrapped as Activity, dispatched to worker
<Task id="modify" sideEffect agent={codeAgent} output={results}>
  Refactor auth
</Task>
// → Activity.make({ execute: runAgentOnWorker(...) })
// → Output is { outputJson, diffBundle }
// → DiffBundle makes filesystem changes replayable without re-execution
```

Agent tasks default to `sideEffect={true}` since agent calls are inherently
side-effectful. `computeFn` tasks default to `sideEffect={false}`.

#### `DurableDeferred` replaces approvals and WaitForEvent

```ts
// <Approval id="human-review" /> compiles to:
const approval = DurableDeferred.make("human-review", {
  success: Schema.Struct({ approved: Schema.Boolean }),
});

// Inside workflow: suspends until resolved
const result = yield* DurableDeferred.await(approval);

// CLI/API resolves it:
yield* DurableDeferred.done(approval, {
  token: DurableDeferred.token(approval),
  exit: Exit.succeed({ approved: true }),
});
```

Eliminates `_smithers_approvals` table, `src/engine/approvals.ts` (250 lines),
manual `waiting-approval` status management, and the approval resolution path.

#### `DurableClock` replaces Timer component

```ts
// <Timer id="wait-1h" duration="1h" /> compiles to:
const timer = DurableClock.make({ name: "wait-1h", duration: "1 hour" });
yield* DurableClock.sleep(timer);
// Survives process restarts
```

### Cluster: `@effect/cluster` replaces transport + workers

#### `Entity` replaces sandbox transport

Each sandbox becomes a cluster entity:

```ts
const SandboxEntity = Entity.make("Sandbox", [
  Rpc.make("execute", {
    payload: Schema.Struct({
      workflowPath: Schema.String,
      input: Schema.Unknown,
      config: SandboxConfigSchema,
    }),
    success: Workflow.Result({
      success: Schema.Unknown,
      error: SmithersErrorSchema,
    }),
  }),
  Rpc.make("cancel", { payload: {} }),
  Rpc.make("heartbeat", {
    payload: {},
    success: Schema.Struct({ alive: Schema.Boolean }),
  }),
]);
```

The 5-method transport (`create/ship/execute/collect/cleanup`) is replaced by
entity lifecycle — `Entity.toLayer()` registers the sandbox with sharding,
`Entity.client` creates a typed client. Sharding handles routing, persistence,
and failover automatically.

#### `SingleRunner` for local execution (default)

```ts
const LocalRunnerLayer = SingleRunner.layer.pipe(
  Layer.provide(SqlMessageStorage.layer),
  Layer.provide(SqlRunnerStorage.layer),
  Layer.provide(SqliteClient.layer({ filename: "smithers.db" })),
);
```

Full cluster infrastructure (persistence, replay, etc.) without distributing
anything. The worker is this process.

#### `HttpRunner` / `SocketRunner` for remote sandboxes

```ts
// Parent — connects to sandbox runner:
const SandboxRunnerLayer = HttpRunner.layerClient.pipe(
  Layer.provide(Layer.succeed(RunnerAddress, { host, port })),
);

// Sandbox process — runs as HTTP runner:
const SandboxWorkerLayer = HttpRunner.layerServer.pipe(
  Layer.provide(SandboxEntity.toLayer(...)),
);
```

#### `Sharding` replaces task queues

```ts
// Instead of the inline dispatch loop:
for (const task of runnable) {
  const p = executeTask(adapter, db, runId, task, ...);
  inflight.add(p);
}

// Sharding routes to the right entity:
const taskClient = yield* TaskWorkerEntity.client;
for (const task of runnable) {
  yield* taskClient(workerId).execute(task);
}
```

`Sharding.getShardId()` handles routing. `MessageStorage` handles persistence.
`Runner` handles health checks and shard reassignment on failure.

### RPC: `@effect/rpc` replaces server/CLI communication

```ts
const SmithersRpcGroup = RpcGroup.make(
  Rpc.make("approve", {
    payload: Schema.Struct({ runId: Schema.String, nodeId: Schema.String }),
    success: Schema.Void,
  }),
  Rpc.make("cancel", {
    payload: Schema.Struct({ runId: Schema.String }),
    success: Schema.Void,
  }),
  Rpc.make("signal", {
    payload: Schema.Struct({
      runId: Schema.String,
      signalName: Schema.String,
      data: Schema.Unknown,
    }),
    success: Schema.Void,
  }),
);
```

Typed, schema-validated API with automatic serialization, error handling, and
OpenTelemetry spans — replacing the hand-rolled routes in `src/server/index.ts`.

---

## Part 2: Worker model

### Architecture

```
┌──────────────────────────┐       ┌──────────────────────┐
│      Orchestrator        │       │      Worker(s)        │
│                          │       │                       │
│  render React JSX        │       │  receive Activity     │
│  build plan tree         │  ──>  │  execute agent/fn     │
│  schedule tasks          │queue  │  stream heartbeats    │
│  dispatch to workers     │  <──  │  return JSON output   │
│  replay events           │       │  return DiffBundle    │
│  persist to event log    │       │                       │
└──────────────────────────┘       └───────────────────────┘
```

The orchestrator sends a serializable `WorkerTask` to a worker. The worker
executes it and returns a `TaskResult`. The worker never touches the DB.

### WorkerTask (serializable)

The existing `TaskDescriptor` has non-serializable parts (`computeFn`, agent
object, Drizzle table reference). Split into:

```ts
type WorkerTask = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  prompt: string | null;
  agentId: string;           // resolved from agent registry
  agentConfig: AgentConfig;
  tools: string[];           // tool names, not live functions
  previousHeartbeat: unknown | null;
  idempotencyKey: string;    // ${runId}:${nodeId}:${iteration}:${attempt}
  rootDir: string;
  allowNetwork: boolean;
  toolTimeoutMs: number;
  maxOutputBytes: number;
};

type TaskResult = {
  nodeId: string;
  iteration: number;
  attempt: number;
  status: "finished" | "failed" | "cancelled";
  outputJson: string | null;
  diffBundle: DiffBundle | null;
  errorJson: string | null;
  durationMs: number;
};
```

### DiffBundle — stateless filesystem output

Side effects that modify files capture changes as serializable diffs:

```ts
type DiffBundle = {
  seq: number;
  baseRef: string;                 // git/jj pointer at task start
  patches: FilePatch[];
};

type FilePatch = {
  path: string;
  operation: "add" | "modify" | "delete";
  diff: string;                    // unified diff format
  binaryContent?: string;          // base64 for binary files
};
```

Worker starts task, captures `baseRef`, agent modifies files, worker computes
diff, returns `{ outputJson, diffBundle }`. On replay: apply `diffBundle`
patches instead of re-running the agent. For sandboxes: sandbox computes diffs
against its local repo, streams them back, parent applies patches — no shared
filesystem needed.

### Worker types

- **LocalWorker**: In-process. Current `executeTask()` wrapped in the Activity
  interface. Zero serialization overhead — just a function call.
- **SandboxWorker**: Cluster entity (bubblewrap, Docker, or Codeplane).
  Communicates via `@effect/rpc` + `HttpRunner`/`SocketRunner`.
- **RemoteWorker**: HTTP runner on a different machine. Same protocol as sandbox.

---

## Part 3: Event-driven scheduling

### Current problem

```ts
while (true) {
  render → schedule → for (const task of runnable) { executeTask() }
  await Promise.race([...inflight]); // BLOCKS until one finishes
}
```

### Replacement: Reactive event loop

```ts
const runScheduler = Effect.gen(function* () {
  const triggerQueue = yield* Queue.unbounded<ScheduleTrigger>();

  // Task completions trigger re-evaluation
  eventBus.on("event", (event) => {
    if (event.type === "NodeFinished" || event.type === "NodeFailed") {
      Queue.unsafeOffer(triggerQueue, { reason: "task-completed", event });
    }
  });

  // External events (signals, approvals) also trigger
  eventBus.on("event", (event) => {
    if (event.type === "SignalReceived" || event.type === "ApprovalGranted") {
      Queue.unsafeOffer(triggerQueue, { reason: "external-event", event });
    }
  });

  yield* Queue.offer(triggerQueue, { reason: "initial" });

  while (true) {
    const trigger = yield* Queue.take(triggerQueue);
    const batch = yield* Queue.takeAll(triggerQueue); // batch simultaneous

    const { runnable, finished } = yield* renderAndSchedule();
    if (finished) break;

    for (const task of runnable) {
      yield* taskQueue.enqueue(task); // non-blocking dispatch
    }
  }
});
```

No `Promise.race` blocking. Multiple completions batched. External events
trigger immediate re-scheduling.

---

## Part 4: Workflow versioning

### `usePatched()` for safe migration

```tsx
import { usePatched } from "smithers";

function MyWorkflow(ctx) {
  const useNewAgent = usePatched("switch-to-gpt4");
  return (
    <>
      <Task id="analyze"
        agent={useNewAgent ? gpt4Agent : gpt3Agent}
        output={results}
      >Analyze</Task>
      {usePatched("add-validation") && (
        <Task id="validate" computeFn={validate} output={validated} />
      )}
    </>
  );
}
```

Patch decisions are recorded in the event log. On replay, `usePatched()` returns
the same value — deterministic. Old runs see `false` for patches they never
recorded. New runs see `true`.

### Graph shape validation

Each frame's task graph shape is hashed and recorded. On resume, if the hash
differs from the last logged one, emit `WorkflowGraphDiverged` event.

---

## Part 5: Sandbox edge cases

### Non-idempotent operations

**1.1 Sandbox executes non-idempotent task, crashes before reporting**

Example: Agent creates a GitHub PR, sandbox crashes before streaming
`NodeFinished` back. Parent tells sandbox to re-execute → PR created twice.

Mitigation: (a) idempotency keys (`{runId}:{nodeId}:{iteration}:{attempt}`)
passed to tool calls; (b) stream `ToolCallStarted` event before execution so
parent knows what was attempted; (c) on resume, check for in-flight tool calls.

**1.2 Sandbox completes task, parent crashes before persisting ACK**

Sandbox streams `NodeFinished`, parent receives but crashes before writing DB.
Sandbox has moved on.

Mitigation: Sandbox persists its own event log durably. On resume, parent sends
`resume(lastAckedSeq: N)`, sandbox replays from N+1. If sandbox's log is gone
(container destroyed), re-execute from parent's checkpoint.

**1.3 Both crash simultaneously**

Parent restarts, provisions new sandbox, resumes from last persisted state.
New instance re-runs from beginning or from parent's last checkpoint.

**1.4 Task writes file, another task reads it, crash between them**

Mitigation: DiffBundle. After each task, sandbox computes and streams filesystem
diff. Parent stores these. On resume in new sandbox, parent replays stored diff
bundles to reconstruct filesystem state.

### Health checks and liveness

**2.1 Sandbox stops responding** — Parent sends periodic health pings via
cluster entity. `RunnerHealth` handles detection. Recovery: tear down entity,
re-provision, resume from checkpoint.

**2.2 Network partition — two sandboxes running**

Mitigation: Fencing via cluster sessions. `Sharding` handles shard reassignment
on runner failure. Old runner's messages rejected when shard moves to new runner.
Additionally: sandbox pauses execution on connection loss, self-terminates after
timeout.

**2.3 OOM / disk full** — Detected via runner health. Same recovery as any crash.
Prevention: resource limits in sandbox config (already in `SandboxProps`).

### Large outputs and conflicts

**3.1 Large diff bundles (50MB+)** — Stream as separate messages with own
sequence numbers. Apply backpressure. Compress (gzip/zstd). Reject oversized.

**3.2 Diff conflicts with parent working tree** — Detect when applying. Fail the
sandbox (user chooses version), or three-way merge with base as common ancestor.

**3.3 Clock skew** — Use `seq` (monotonic counter) for ordering, not timestamps.
Parent records `receivedAtMs` alongside sandbox's `timestampMs`.

### Lifecycle

**4.1 Can't import workflow module** — Sandbox engine fails at `import()`, emits
`RunFailed`. Parent receives early failure. Nothing to recover.

**4.2 Schema mismatch** — Include `workflowHash` and `schemaSignature` in
handshake. Mismatch → error before execution.

**4.3 Hot reload while sandbox running** — Sandbox continues with old version.
Isolated by design. Document this behavior.

**4.4 Parent cancels mid-agent-call** — Send cancel via cluster messaging.
Sandbox triggers `AbortController.abort()`. Grace period, then force-terminate.

**4.5 Sandbox output fails parent schema validation** — Parent validates on
activity result decode. Validation fails → task marked failed. Retry if
configured.

---

## Part 6: What gets deleted

| File/module | Lines | Replaced by |
|---|---|---|
| `src/db/ensure.ts` (internal tables) | ~200 | `SqlMessageStorage` auto-schema |
| `src/db/adapter.ts` (mutation methods) | ~800 | `MessageStorage` + `SqlClient` |
| `src/engine/approvals.ts` | ~250 | `DurableDeferred` |
| `src/engine/child-workflow.ts` | 132 | `Workflow.execute()` (child) |
| `src/sandbox/transport.ts` | 220 | `Entity` + `Sharding` |
| `src/sandbox/execute.ts` | 436 | `ClusterWorkflowEngine` |
| `src/sandbox/bundle.ts` | 221 | DiffBundle in Activity result |
| `src/events.ts` (EventBus) | ~260 | `MessageStorage` + `PubSub` |
| Custom retry/heartbeat in engine | ~500 | `Activity.retry()` built-in |
| Manual attempt tracking | ~200 | `Activity.CurrentAttempt` |
| Manual idempotency checks | ~150 | `Activity.idempotencyKey()` |
| **Total** | **~3,400** | **Replaced by imports** |

## What stays unchanged

- `src/components/*.ts` — JSX component definitions (user-facing API)
- `src/dom/*.ts` — React renderer and XML extraction
- `src/engine/scheduler.ts` — Plan tree building and task scheduling logic
- `src/agents/*.ts` — Agent implementations
- `src/tools/*.ts` — Tool implementations
- `src/cli/index.ts` — CLI commands (refactored to use RPC client)
- `src/server/index.ts` — HTTP server (refactored to use RPC server)
- User-defined output tables (Zod→Drizzle) — kept on drizzle

---

## Rollout phases

### Phase 0: Dependencies + adapter seam (no behavior change)

1. `bun add @effect/workflow @effect/cluster @effect/rpc @effect/sql-sqlite-bun`
2. Create `src/effect/workflow-bridge.ts` — thin adapter between current engine
   and new Effect types. Lets us swap internals incrementally.
3. Add `WorkflowEngine` service from `layerMemory` (in-memory, for testing).
4. Verify all 185 existing test files pass.

### Phase 1: Activities — replace executeTask()

1. Wrap each `TaskDescriptor` execution as `Activity.make()`
2. `Activity.retry()` replaces the manual retry loop
3. `Activity.CurrentAttempt` replaces manual attempt tracking
4. `Activity.idempotencyKey()` replaces manual idempotency
5. Side-effect tasks produce `{ outputJson, diffBundle }` via DiffBundle
6. **Contract test**: Extract existing `executeTask` behavior into contract,
   verify Activity implementation passes the same contract.

### Phase 2: DurableDeferred — replace approvals + WaitForEvent

1. `DurableDeferred.make()` replaces `_smithers_approvals` table
2. `DurableDeferred.await()` replaces `waiting-approval` status
3. `DurableDeferred.done()` replaces `approve` command handler
4. `DurableClock` replaces Timer component
5. **Contract test**: Approval E2E tests pass with DurableDeferred backend.

### Phase 3: Workflow.make() — replace SmithersWorkflow

1. `Workflow.make()` wraps the React scheduler loop
2. `Workflow.intoResult()` handles suspend/resume
3. Child workflows use `Workflow.execute()` with parent linkage
4. Event-driven scheduling replaces `while(true) { Promise.race }` loop
5. `usePatched()` for versioning
6. **Contract test**: Full workflow E2E tests pass. Resume-after-crash works.

### Phase 4: SqlMessageStorage — replace custom tables

1. `@effect/sql-sqlite-bun` replaces `drizzle-orm/bun-sqlite` for internal tables
2. `SqlMessageStorage` replaces `_smithers_events`, `_smithers_runs`,
   `_smithers_nodes`, `_smithers_attempts`
3. User output tables stay on drizzle
4. **Contract test**: Event persistence round-trips. Replay produces same state.

### Phase 5: Entity + Sharding + SingleRunner — worker model

1. `Entity.make("TaskWorker", [...])` for local task dispatch
2. `SingleRunner` for in-process execution (default — zero overhead)
3. `WorkerTask` / `TaskResult` as serializable types
4. All task dispatch goes through entity + sharding
5. **Contract test**: All engine tests still pass. Tasks dispatch through worker
   interface.

### Phase 6: Sandbox as cluster entity

1. `Entity.make("Sandbox", [...])` replaces transport service
2. `HttpRunner` for Docker/Codeplane sandboxes
3. `SocketRunner` for bubblewrap (stdio)
4. Fencing tokens for session management
5. DiffBundle streaming + conflict detection
6. Health checks via `RunnerHealth`
7. Edge case handling: non-idempotent ops, crash recovery, network partition
8. **E2E test**: `<Sandbox runtime="bubblewrap">` runs task, output arrives in
   parent. Crash → resume works.

### Phase 7: RPC — replace server/CLI communication

1. `RpcGroup` defines Smithers API schema
2. `RpcServer` replaces hand-rolled HTTP routes
3. `RpcClient` replaces hand-rolled CLI→server communication
4. **Contract test**: Server tests pass with RPC backend.

---

## Codebase context

### Primary files to refactor

- `src/engine/index.ts:2436-5391` — `executeTask` + `runWorkflowBody` + scheduler
  loop (~3,000 lines). Split into orchestrator, scheduler, and Activity dispatch.
- `src/engine/index.ts:4363-5307` — `while (true)` scheduler loop (~950 lines).
  Becomes reactive event-driven scheduler.
- `src/engine/index.ts:5266-5283` — Task dispatch loop (17 lines). Becomes
  entity-routed dispatch.
- `src/db/adapter.ts` — Mutation methods become `MessageStorage` calls.
- `src/db/ensure.ts` — Internal table DDL replaced by `SqlMessageStorage`.
- `src/sandbox/transport.ts` — Becomes `SandboxEntity` + cluster runner.
- `src/sandbox/execute.ts` — Becomes `ClusterWorkflowEngine` integration.
- `src/events.ts` — `EventBus` replaced by `MessageStorage` + `PubSub`.
- `src/SmithersEvent.ts` — Adapt event types to cluster message schemas.

### New files

- `src/effect/workflow-bridge.ts` — JSX→Workflow bridge
- `src/effect/activity-bridge.ts` — Task→Activity bridge
- `src/effect/worker.ts` — Worker interface + LocalWorker
- `src/effect/diff-bundle.ts` — DiffBundle computation/application
- `src/effect/versioning.ts` — `usePatched()` implementation
- `src/effect/sandbox-entity.ts` — Sandbox cluster entity definition
- `src/effect/rpc-schema.ts` — Smithers RPC protocol definition

### Effect patterns to follow

```ts
// All new modules use the Effect service pattern:
import { Effect, Context, Layer } from "effect";

class TaskQueue extends Context.Tag("TaskQueue")<
  TaskQueue,
  {
    enqueue: (task: WorkerTask) => Effect.Effect<void>;
    dequeue: Effect.Effect<WorkerTask>;
  }
>() {}

const TaskQueueLive = Layer.effect(TaskQueue, Effect.gen(function* () {
  const queue = yield* Queue.bounded<WorkerTask>(100);
  return {
    enqueue: (task) => Queue.offer(queue, task),
    dequeue: Queue.take(queue),
  };
}));
```

---

## Verification strategy

### Contract tests (per phase)

Before each phase, extract existing behavior into a test contract:

```ts
describe("Activity contract", () => {
  it("executes task and persists result");
  it("retries on transient failure up to N times");
  it("returns cached result on replay");
  it("generates deterministic idempotency key");
  it("tracks heartbeats during execution");
});
```

Run contract against old implementation. Swap in new implementation. Verify same
contract passes.

### Existing test coverage (185 test files)

Critical tests for this refactor:

| Test file | Lines | Covers |
|---|---|---|
| `engine-scheduler-plan.test.ts` | 157 | Scheduler logic (kept) |
| `scheduler-advanced.test.ts` | 493 | Complex scheduling (kept) |
| `scheduler-comprehensive.test.ts` | 691 | Full coverage (kept) |
| `engine-approvals.test.ts` | ~200 | Phase 2 contract |
| `engine.apply-limits.test.ts` | ~200 | Concurrency limits (kept) |
| `retry-policy.test.ts` | ~150 | Phase 1 contract |
| `time-travel-replay.test.ts` | ~200 | Phase 3 contract |
| `sandbox-bundle.test.ts` | ~150 | Phase 6 contract |
| `workflow-command.e2e.test.ts` | 286 | Ultimate smoke test |

### New tests needed

1. **Workflow replay**: Start → complete 2 activities → crash → resume → verify
   activities 1-2 return cached results, activity 3 executes fresh.
2. **DurableDeferred round-trip**: Create → persist → restart process → resolve
   via token → workflow resumes.
3. **Entity routing**: Register two workers → dispatch 10 tasks → verify
   distribution.
4. **SqlMessageStorage migration**: Insert events via old adapter → read via new
   MessageStorage → verify equivalence.
5. **DiffBundle replay**: Execute side-effect task → capture diff → replay →
   verify filesystem matches without re-executing agent.
6. **Sandbox crash recovery**: Start sandbox → complete 3 tasks → kill sandbox →
   resume → verify tasks 1-3 cached, task 4 executes.
7. **Fencing rejection**: Same sandbox ID, old session sends event → verify
   rejected.
8. **Non-idempotent tool call**: Task with external API call crashes → resume →
   verify idempotency key prevents duplicate.
9. **Reactive scheduling**: Tasks A,B,C in flight → A finishes, unlocks D,E →
   verify D,E scheduled immediately (not after B or C finish).
10. **usePatched() determinism**: Record patch → replay → verify same value
    returned.

### Edge case tests (sandbox)

11. Can't import workflow module → clean error, no retry
12. Schema mismatch in handshake → error before execution
13. Heartbeat timeout → sandbox torn down and re-provisioned
14. Diff bundle conflict with parent working tree → detected
15. Clock skew — events ordered by seq not timestamp
16. Large output (>maxOutputBytes) → rejected gracefully
17. Sandbox OOM → parent detects exit code, recovers
18. Parent crash during sandbox → parent restarts, resumes
19. Sandbox inside `<Ralph>` loop → each iteration gets fresh sandbox
20. Multiple sandboxes in parallel with `dependsOn`
21. Hot reload on parent while sandbox running → sandbox unaffected
22. Parent hijack while sandbox active → sandboxes cancelled
23. Sandbox modifies files outside scope → blocked by runtime + path validation

---

## Risk assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| JSX→Workflow bridge complexity | High | High | Phase 0 prototype first |
| Effect package version mismatch | Medium | High | Pin exact versions, CI |
| SqlMessageStorage schema differs | Medium | Medium | Keep user tables on drizzle |
| Performance regression | Low | Medium | Benchmark scheduler loop |
| Breaking user-facing API | Low | High | JSX layer unchanged |
| Effect cluster learning curve | Medium | Low | SingleRunner first |
| Partial migration state | Medium | Medium | Contract tests per phase |

---

## Part 7: Observability, Metrics, and Alerting

By moving to the Effect ecosystem, we inherit enterprise-grade observability and metrics out-of-the-box. We must surface these via OpenTelemetry and Prometheus to allow users to monitor Smithers at scale.

### 1. Visibility (Tracing)

Effect's built-in span tracking (`Effect.withSpan`) automatically captures deep hierarchical traces of every workflow and activity execution.

- **OpenTelemetry Export**: We will configure `@effect/opentelemetry` to export traces. This will allow monitoring of exact timing for UI rendering, task planning, and worker execution.
- **Trace Context Propagation**: Because cluster entities communicate via `@effect/rpc`, trace IDs propagation is built-in across process boundaries (Parent Orchestrator → Remote Sandbox Worker).

### 2. Prometheus Metrics

The `@effect/cluster` ecosystem natively exposes Prometheus-friendly operational metrics.

- Use `@effect/platform/HttpServer` combined with `effect/Metric` to expose a `/metrics` route on the orchestrator.
- **Core Metrics**:
  - `effect_cluster_entities`: Number of active sandbox workers.
  - `effect_cluster_runners`: Total available execution nodes.
  - `effect_cluster_runners_healthy`: Health status gauge.
  - `effect_cluster_shards`: Active message queues/routing partitions.
- **Custom Metrics**: We will add `smithers_workflow_duration`, `smithers_activity_success_rate`, and `smithers_agent_tokens_used` metrics using `Metric.timer` and `Metric.counter` alongside our tool calls.

### 3. Alerting and Error Boundaries

With clear demarcation of worker health and workflow SLAs, we can build robust alerting rules (e.g., via Alertmanager):
- **SLA Alerting (Timeouts)**: Alerts triggered if a `DurableDeferred` sits unresolved (e.g., waiting for human approval > 24h) or if an Activity exceeds `toolTimeoutMs`.
- **Worker Starvation**: Alert if `RunnersHealthy` drops below minimum defined replica count.
- **Heartbeat Failures**: If cluster `RunnerHealth` identifies a partitioned sandbox, trigger automatic termination and re-routing.

---

## Part 8: TDD Strategy (Contract Testing & Equivalence)

The transition must be extremely safe, achieved via rigorous Contract Testing.

### Equivalence Verification

Instead of rewriting our tests, we will execute our existing test suites simultaneously across both the **Legacy** and **V2** engines.

1. **Extract Existing Contracts**: Define explicit test contracts for core behaviors (e.g., `executeTask`, `DurableDeferred` await, child workflow termination).
2. **Dual-Backend Test Runner**: For every contract test, invoke the Legacy engine and the Effect engine. Validate that the terminal outputs (`Workflow.Result`, DB state mutations) are indistinguishable.
3. **Diff-Based Assertions**: Use Jest/Vitest snapshots on the internal state (especially for File patches and DiffBundles) to guarantee mathematical equivalence upon sandbox recovery.

This TDD approach prevents us from progressing to Phase (N+1) until Phase N is 100% compliant with its predecessor.
