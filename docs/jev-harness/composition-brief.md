# Composition brief: one cell-loop turn per prompt on the durable engine

Lane: composition. Date: 2026-09-17. Status: proven by a runnable spike, nothing committed.

The recipe below runs one `Agent.run` per prompt inside a registered durable flow on a SQLite engine under `<dir>/.smithers/`, without the control plane (`SqlControlRuntime`, `ControlLive`, `AgentSession`). The spike proved a completed turn, a same-id replay with zero provider calls, a permission park that resumes the same execution id, a steer drained at a frame boundary, and an interrupt that cancels the row. It also found twelve traps the engineering doc does not mention. Section numbers refer to `engineering.html` (E) and `design.html` (D).

## 1. Results

Spike: `scratchpad/composition/run-one-turn.ts` (source in section 12). Repository: `scratchpad/composition/spike-repo`, one `README.md` whose first line is `Spike repo for the OpenCode composition brief.` Seat: `cerebras:gpt-oss-120b` (section 4 says why not OpenAI). Engine file: `spike-repo/.smithers/opencode-spike.sqlite`.

| Proof | Execution id | What happened | Provider calls |
| --- | --- | --- | --- |
| A. One turn | `msg_run4`, `msg_run11` | `read` served through the guarded filesystem, `Resolved` text = the README's first line, row `completed` | 2 |
| A2. Same execution id again | `msg_run4` | `engine.poll` answered `Complete` before execute, `execute` returned in 53 ms, the body never ran | 0 |
| A3. New execution id, same session and prompt | `msg_run5` | a new run; the sealed model step is keyed per run, so the model was asked again | 2 |
| B. Permission park | `msg_run6`, `msg_run8` | `permission-required` then `suspended` events; row `suspended`, owner and claim null, waiting row `{reason: "approval", token: "per_ses_8_0_68c24d24_0"}`; grant installed; `engine.resume` re-drove the same id; frame 0 replayed with no provider call; `bash` ran and the answer was the README line | 1 before, 1 during resume |
| C. Steering | `msg_run7` | message pushed at the first `turn-opened`; `steering-drained messages=1` at boundary `0:<cell digest>`; the completion was bounced and the next frame answered `... STEERED` | 2 |
| E. Interrupt | `msg_run10`, `msg_run12` | `engine.interrupt` recorded `cancel-requested`, the body fiber exited with an interrupt-only cause and `instance.suspended === false`, journal `flows.engine.interrupted outcome=cancelled`, row `cancelled`. No `Aborted` event reached the consumer | 1 |

Engine journal for `msg_run8` (`flows.engine.run-decision`): `created, claimed-and-activated, resumed, transitioned, wake-scheduled, claimed-and-activated, resumed, transitioned`. The second `claimed-and-activated` is the resume of the same execution id.

## 2. Exact imports

```ts
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"      // Bun only
import { NodeCrypto, NodeHttpClient } from "@effect/platform-node"
import * as Agent from "@smthrs/agent/Agent"
import { patterns, settlementFailure } from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import { contextWindowResolver, SeatResolver } from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as BunRuntime from "@smthrs/flows/BunRuntime"                    // Bun only
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"                  // Node only
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as Cell from "@smthrs/harness/Cell"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as Jj from "@smthrs/jj"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as HttpClient from "effect/unstable/http/HttpClient"
```

`@smthrs/cli/NodeControl` is the public export of `packages/smithers/src/NodeControl.ts`. It carries `layerGuardedPlatform`, `layerGrantStore`, `layerRegistry`, `layerSeatResolver`, `executionDatabasePath`. It does not export `cellLimits`; the values are `{ memoryBytes: 256 * 1024 * 1024, steps: 50_000_000 }` (`src/internal/NativeEquipment.ts`).

## 3. Layer stack, in order

Bottom to top. Each line names the layer value and what it gives the one above it.

1. `platform = NodeControl.layerGuardedPlatform(dir)`. Kernel `FileSystem` confined to `dir` over `AtomicFileSystem` (the python3 helper) and `NodeServices` (`Path`, raw `ChildProcessSpawner`, `HttpClient`). The default grant store is allow-all; pass a second argument to supply a real one, and give the same store to the spawner below.
2. `spawner = KernelChildProcessSpawner.layer.pipe(Layer.provide(NodeControl.layerGrantStore(dir)), Layer.provideMerge(platform))`. The guarded shell. Production adds `ProcessReaper.layerSpawner` and `ProcessLedger.layer` under it (`NativeControl.ts` `contain()`); the spike skips the reaper.
3. `requestExecutor = RequestExecutor.layer.pipe(Layer.provide(<http client>))`. Node: `NodeHttpClient.layerUndici`. Bun: `BunHttpClient.layer`. The spike wraps the client with `HttpClient.tapRequest` to count provider calls.
4. `seats = NodeControl.layerSeatResolver(process.env).pipe(Layer.provide(requestExecutor))`.
5. `agent = Agent.layer.pipe(Layer.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())))`.
6. `registry = NodeControl.layerRegistry(dir)`. Scans `<dir>/flows`; a missing directory is an empty catalog, an unreadable one dies.
7. `jj = Jj.layerNoop({ snapshot, restore, diff })`. The engine requires `Jj.Jj` at construction. Only compensable actions call `SnapshotBoundary`; the model step and cell calls do not, so the noop is never invoked in this composition. Production passes `NodeJj.layerAt(workspaceRoot)`; it was not tried against a git-only checkout.
8. `registration = Layer.effectDiscard(register the turn flow)`, provided with `[agent, seats, registry, spawner]`. Section 6 shows the body.
9. `engine = <NodeRuntime | BunRuntime>.layer({ filename, workspaceRoot: dir, owner: { hostId: hostname() }, isAlive: Ownership.sameHostPidProbe }, StepBoundary.layer, WorkspaceSandbox.layerFileSystem(), registration).pipe(Layer.provide([platform, spawner, NodeCrypto.layer, jj]))`.

At run time, inside the body: `Effect.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded(), QuickJSSandbox.layer))` and `Effect.provideService(Steering.Source, steering)` around `agent.run(...)`. `Agent.layerDefaults` is `QuickJSSandbox.layer` plus a noop steering source; a server that steers replaces the second half, so the spike provides the two separately.

The program runs with `Effect.provide(engine), Effect.scoped, Effect.runPromise`. Closing the scope closes the SQLite connection and interrupts every drive fiber.

## 4. Seat string

`provider:modelId`, resolved by `NodeControl.layerSeatResolver(process.env)`. `openai:<model>` needs `OPENAI_API_KEY` and routes to `https://api.openai.com/v1/responses`. The key in this shell has no credits: the first spike run failed with `You have no credits remaining` after one call (execution `msg_run1`). The proofs ran on `cerebras:gpt-oss-120b`, which the resolver routes through the OpenAI-compatible table (`src/Providers.ts` `compatible`) to `https://api.cerebras.ai/v1/chat/completions` with `CEREBRAS_API_KEY`. The seat string is the session's model id in D section 6 (`GET /api/model`); nothing else in the composition parses it.

## 5. SQLite path convention

`<dir>/.smithers/opencode-spike.sqlite` in the spike; the server should use `<dir>/.smithers/opencode.sqlite` (E section 7 risk table: own file under `.smithers/`). The runtime creates the directory and opens the file in WAL mode (`-wal` and `-shm` beside it). The existing CLI keeps `.flows/engine.db` (`NodeControl.executionDatabasePath(root)`) and `.flows/control.db`; the server must not share either file, because `RunStore.layer` is a singleton layer and two engines over one file steal each other's rows. E section 4.2 wants the message store in the same file as the engine store: the engine layer exposes `SqlClient` (`@smthrs/database`) to the registration context, so a `Store.ts` can run its own migration on the same connection.

## 6. The FlowInstance requirement, and the exact way to start a run

`Agent.Service.run` requires `FlowRuntime.FlowInstance` (and `FlowRuntime.FlowRuntime`, `Sandbox`, `Steering.Source`, `Budget`, `QuotaClassifier`). `FlowInstance` exists only inside the `execute` handler passed to `engine.register`. So a server registers one flow once, at boot, and every prompt is `engine.execute` of that flow:

```ts
const turnFlow = Flow.make("opencode/turn", {
  payload: { session: Schema.String, prompt: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)   // inert; the behaviour is the registered execute
})

const registration = Layer.effectDiscard(Effect.gen(function*() {
  const engine = yield* FlowRuntime.FlowRuntime
  const agent = yield* Agent.Agent
  const seats = yield* SeatResolver
  const registry = yield* Registry.Registry
  yield* engine.register(turnFlow, (payload) => Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance          // executionId, lineageId, suspended, waiting
    const seat = yield* seats.resolve(seatId)
    const fsServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    const shellServices = yield* Effect.context<KernelChildProcessSpawner.ChildProcessSpawner | Path.Path>()
    const engineServices = yield* Effect.context<Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>()
    return yield* agent.run({
      contextWindowTokensFor: contextWindowResolver(seats),
      session: payload.session,
      seat,
      prompt: payload.prompt,
      registry,
      flows: [StandardFlows.filesystem(fsServices), StandardFlows.shell(shellServices), StandardFlows.clock(engineServices)],
      authorize: authorize(instance),
      capabilityEnvelope: patterns(["fs:read:/**", "fs:write:/**", "proc:spawn:*"]),
      limits: { memoryBytes: 256 * 1024 * 1024, steps: 50_000_000 },
      maxFrames,
      approvalChannel: true,
      unmovedCap: 0
    }).pipe(
      /* fold the Stream<AgentEvent>: project each event, keep the complete transition's output */
      Effect.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded(), QuickJSSandbox.layer)),
      Effect.provideService(Steering.Source, steering)
    )
  }).pipe(Effect.mapError(settlementFailure)))
}))
```

The engine merges the registration context into every execution (`FlowEngine/make.ts` `Effect.updateContext`), so the body finds `FileSystem`, `Path`, the spawner, `Crypto`, the stores and the services the registration was provided with.

Starting a prompt:

```ts
yield* Effect.forkChild(engine.execute(turnFlow, { executionId: messageId, payload: { session, prompt }, discard: true }))
```

`execute` with `discard: true` on the durable engine returned only after the round settled (20 s in run A, section 10 trap 5), so the server forks it, as `AgentSession.driver` does. The body's exit is the fastest signal that a turn ended; the engine writes the terminal row after the handler returns, so `engine.poll` still answers `Option.none()` (in flight) for a few milliseconds after the body has completed. Treat the execution as settled when the forked `execute` returns, or when `poll` answers `Complete`.

## 7. Execution id convention

Caller-chosen, confirmed: `engine.execute(flow, { executionId, payload, discard })` takes the id, `AgentSession` passes the control run id, the spike passed `msg_run4` and read it back from `instance.executionId` and the `flows_runs.run_id` column. `lineageId` is `smithers-journal-lineage/v1:["msg_run4"]`. Using the assistant message id (E section 4.1) works.

Re-executing a completed id (A2) does not run the body: the engine answers `Complete` from `flows_runs` in 53 ms and the provider is not called. That is the restart-safe path for a `POST /prompt` retried with the same message id. A new id with the same `session` string and prompt (A3) is a new run and asks the model again: the sealed model step's key material includes `scope.run`, so sealed replay is per execution, not per session. `session` in `Agent.run` scopes call identities and steering boundaries; it does not share model answers across executions.

## 8. Parked executions: list on boot, resume after a grant

Listing: `DurableEngineState.waitingRuns({ reason: "approval" })` returns `[{ runId, reason: "approval", wakeAt: null, token: "<requestId>" }]` for every parked execution in the file; `waitingRuns()` with no filter lists every parked reason. `RunStore.get(runId)` gives `status: "suspended"`, `owner: null`, `claim: null`, and `stateJson` with `flowName` for filtering to `opencode/turn`. Both services are in the engine's context (the spike reads them beside `FlowRuntime.FlowRuntime`).

Resume: install the grant (section 9), then `engine.resume(turnFlow, executionId)`. Resume re-drives the same execution id: the body runs from frame 0, the sealed model step of frame 0 replays from the journal (no provider call in run B during the replayed frame), the cell replays its recorded prints, the `authorize` hook is asked again for the same call, passes, and the loop continues into new frames. The Deferred the driver awaits must be re-armed before `resume` because the body runs and exits again.

Boot order: register the flow first (the registration layer), then list and resume. The engine's own registration hook re-arms durable clocks; a parked approval has no clock, so nothing resumes it until the host calls `resume` or the person answers.

The token in the waiting row is what `FlowRuntime.annotateWaiting({ reason: "approval", token })` wrote in the `authorize` hook, so the pending `per_...` request can be rebuilt from the row on boot without a separate table: `token` is the request id, and the `permission-required` event carried `capability` and `meta` (the flow name and input) for the UI.

## 9. Per-session grants and the authorize hook

The hook is `Agent.Options.authorize`, called before a call's durable boundary opens. It is the only correct place: a refusal raised inside the boundary would be journaled and replayed forever (`Agent.ts` comment on `authorize`).

```ts
const grants = new Set<string>()   // per session: flow names the person allowed ("always")
const authorize = (instance) => (call: Cell.Call) => Effect.gen(function*() {
  if (call.flowName !== "bash" || grants.has("bash")) return
  const i = call.identity
  const requestId = `per_${i.session}_${i.frame}_${i.cell.slice(0, 8)}_${i.ordinal}`
  yield* Effect.provideService(FlowRuntime.annotateWaiting({ reason: "approval", token: requestId }), FlowRuntime.FlowInstance, instance)
  return yield* Effect.fail(new HarnessError({
    code: "engine_failed",
    message: "Permission required: bash",
    cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(new Permission.PermissionRequired({
      code: "permission_required", requestId, runId: instance.executionId,
      capability: Capability.make("proc:spawn", "bash"), tier: "irreversible",
      meta: { flow: "bash", input: call.input }
    }))
  }))
})
```

The request id is derived from the call identity, which is stable across replay, so the resumed attempt asks the same question and a `once` grant keyed by request id matches it. `always` is a grant keyed by flow name (and pattern, if the server matches on `call.input`). The cause must be the encoded class, not the instance: `CellTurn.permissionRequired` decodes it, and a live `Error` does not survive the journal. `annotateWaiting` must run with the instance passed explicitly; the hook runs on the frame's fiber, whose context has the instance only when provided, which is why the spike closes over `instance` from the body.

Reject is not proven. The hook's error channel is the frame failure: a `HarnessError` without a `PermissionRequired` cause fails the whole turn (`The cell frame failed`), not the call. To make `reject` a catchable `permission_denied` call result (D section 6), decorate the `bash` binding: wrap `StandardFlows.shell` with a `FlowBinding` whose handler consults a deny set and fails with a typed refusal carrying `publicError`, the way `StandardFlows.approval` turns `ApprovalUnavailable` into a catchable call failure.

## 10. Interrupt

`engine.interrupt(turnFlow, executionId)` writes `cancel_requested_at_ms`, journals `run-decision cancel-requested`, then interrupts the active fiber. The body exits with an interrupt-only cause and `instance.suspended === false`; a park exits with the same cause and `instance.suspended === true`. `AgentSession.settle` reads that flag for the same reason. The row moves to `cancelled` when the engine settles (the spike read `running` at the instant of exit and `cancelled` a moment later); the journal gains `flows.engine.interrupted {"outcome":"cancelled"}`.

E section 4.1 says the stream's `Aborted` event closes the projection. It does not arrive: the interrupt takes the consumer down with the frame, and no `aborted` or `turn-closed` line appeared in runs `msg_run10` and `msg_run12`. Close the projection from the body's exit (interrupt-only and not suspended), and emit `session.execution.interrupted` from there.

## 11. Traps hit

1. `@smthrs/flows/NodeRuntime` opens `NodeDatabase`, which refuses under Bun: `UnsupportedDatabase: Use @smthrs/database/bun/BunDatabase under Bun`. Under Bun use `@smthrs/flows/BunRuntime` (`src/internal/BunControl.ts` is the CLI's Bun platform and is private).
2. `NodeHttpClient.layerUndici` fails under Bun at request time with `dispatcher.request is not a function` (and `dispatcher.destroy` at scope close). Under Bun use `BunHttpClient.layer`. The transport retry ladder spent 18 calls and 45 s discovering this before the turn failed.
3. `capabilityEnvelope` defaults to nothing granted. Every std flow then answers `capability_refused` (`Flow read needs fs:read:/**, which is outside this run's capability envelope`) and the model burns all frames. Declare the envelope: `patterns(["fs:read:/**", "fs:write:/**", "proc:spawn:*"])` covers `read, write, edit, apply_patch, ls, glob, grep, bash, test`.
4. The flow's `error: Schema.Unknown` cannot encode a live `HarnessError`; the engine logs `the settlement of opencode/turn could not be encoded through its own codec` and persists a JSON projection. Map the body's error through `AgentSession.settlementFailure` before it leaves the handler.
5. `engine.execute(..., { discard: true })` on the durable engine returns after the round settles, not on admission. Fork it.
6. `bash` inherits the process working directory: the kernel spawner passes only an explicit `cwd`, and `Bash.run` sets none unless the cell did. `head -n 1 README.md` failed with `No such file or directory` until the spike called `process.chdir(dir)`. One server serves one directory (D section 6), so change into it at boot.
7. The stream consumer runs inside the frame. A thrown error in the event projection (the spike's first printer read a field that does not exist on `cell-call-settled`) fails the turn and the engine records it as `Complete(failed)`. Keep the projection total and catch inside it.
8. `engine.poll` fails with `FlowExecutionNotFound` until the forked `execute` has created the row; a poll loop that starts before the fork has run must catch it.
9. A completion for a prompt that changes no file is bounced by the unmoved-tree demand (`CellTurn.defaultUnmovedDemands = 1`). Pass `unmovedCap: 0` for conversational prompts, or budget one extra frame.
10. `NodeControl.cellLimits` does not exist on the public surface (the spike's first draft passed `undefined` silently).
11. The in-memory `Steering.Source` must keep a per-boundary ledger and answer a drained boundary with `duplicate: true`; the park path walks rungs `frame:cell:park:N` until it finds one not yet drained. The ledger is per process, so a message admitted while a run is parked and the process restarts is delivered at frame 0 of the replay, not at the park rung. The durable source is `Notifications.make({ runId, lineageId })` from `@smthrs/harness/Notifications` over `NotificationQueue.layer` (`AgentSession.ts` line 1635), which the server should adopt for the busy-session queue in E section 4.1.
12. `OPENAI_API_KEY` in this shell has no credits. The composition is unchanged by the provider; only the seat string moved.

## 12. Spike source

`scratchpad/composition/run-one-turn.ts`, run from `scratchpad/composition` with a `node_modules` directory of symlinks into `packages/smithers/node_modules` plus `@smthrs/cli -> packages/smithers`. Reproduce:

```sh
cd scratchpad/composition
bun run-one-turn.ts spike-repo "Read README.md and answer with its first line." --seat=cerebras:gpt-oss-120b --execution-id=msg_a --session=ses_a
bun run-one-turn.ts spike-repo "Read README.md and answer with its first line." --seat=cerebras:gpt-oss-120b --execution-id=msg_a --session=ses_a   # replay, 0 calls
bun run-one-turn.ts spike-repo "Use the bash flow to run: head -n 1 README.md. Answer with the command's stdout." --park-bash --seat=cerebras:gpt-oss-120b
bun run-one-turn.ts spike-repo "Read README.md and answer with its first line." --steer="Also end your final answer with the word STEERED." --seat=cerebras:gpt-oss-120b
bun run-one-turn.ts spike-repo "Read README.md and answer with its first line." --interrupt-ms=1500 --seat=cerebras:gpt-oss-120b
```

```ts
/**
 * One Smithers cell-loop turn per prompt on the durable engine, without the
 * control plane. This is the composition the @smthrs/opencode server package
 * runs per prompt (engineering doc 4.1).
 *
 * Usage:
 *   bun run-one-turn.ts <dir> <prompt> [--execution-id=ID] [--session=S]
 *        [--seat=openai:gpt-5-mini] [--park-bash] [--steer=TEXT] [--max-frames=N]
 *
 * --park-bash  the authorize hook refuses the first `bash` call with
 *              Permission.PermissionRequired, the execution parks, the host
 *              installs a grant and resumes the SAME execution id.
 * --steer      pushes TEXT into the Steering.Source at the first turn-opened
 *              event; the loop drains it at the frame boundary.
 */
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"
import { NodeCrypto, NodeHttpClient } from "@effect/platform-node"
import * as Agent from "@smthrs/agent/Agent"
import { patterns, settlementFailure } from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import { contextWindowResolver, SeatResolver } from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as BunRuntime from "@smthrs/flows/BunRuntime"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as Cell from "@smthrs/harness/Cell"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as Jj from "@smthrs/jj"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { join, resolve } from "node:path"

// ---------------------------------------------------------------- arguments
const positional: Array<string> = []
const flags = new Map<string, string>()
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=")
    if (eq < 0) flags.set(arg.slice(2), "true")
    else flags.set(arg.slice(2, eq), arg.slice(eq + 1))
  } else positional.push(arg)
}
const dir = resolve(positional[0] ?? ".")
const promptText = positional[1] ?? "Read README.md and answer with its first line."
const seatId = flags.get("seat") ?? "openai:gpt-5-mini"
// Execution id = assistant message id (engineering doc 4.1). Caller-chosen.
const executionId = flags.get("execution-id") ?? `msg_${randomUUID().replaceAll("-", "")}`
const session = flags.get("session") ?? `ses_${randomUUID().replaceAll("-", "")}`
const parkBash = flags.has("park-bash")
const steerText = flags.get("steer")
const maxFrames = Number(flags.get("max-frames") ?? 8)
const interruptAfterMs = flags.has("interrupt-ms") ? Number(flags.get("interrupt-ms")) : undefined
// Trap: `bash` inherits the process working directory (the kernel spawner
// passes only an explicit `cwd`); the CLI runs inside the project, so a
// server that serves one directory changes into it once.
process.chdir(dir)

const log = (line: string) => console.log(line)

// ---------------------------------------------------------------- the flow
/** The one durable flow every prompt executes. The body is inert; the
 * behaviour is the `execute` handed to `engine.register`. */
const turnFlow = Flow.make("opencode/turn", {
  payload: { session: Schema.String, prompt: Schema.String },
  success: Schema.String,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

// ---------------------------------------------------------------- host state
/** Per-session grants: flow names the person allowed. */
const grants = new Set<string>()
/** The body's exit per execution id, for the driver to await. */
const settled = new Map<string, Deferred.Deferred<Outcome>>()
type Outcome =
  | { readonly _tag: "completed"; readonly output: string }
  | { readonly _tag: "failed"; readonly error: string }
  | { readonly _tag: "suspended" }
  | { readonly _tag: "interrupted" }

/** Provider HTTP calls, counted at the transport. */
let providerCalls = 0

// ---------------------------------------------------------------- steering
/**
 * An in-memory Steering.Source with the idempotent-drain ledger the loop
 * requires (a replayed boundary must answer exactly what it answered before).
 */
const steeringQueue = {
  pending: [] as Array<Steering.Item>,
  ledger: new Map<string, Steering.DrainRecord>(),
  drained: [] as Array<string>
}
const steering = Steering.make({
  read: () => Effect.succeed({ items: [...steeringQueue.pending] }),
  drain: ({ boundary, wouldIdle }) =>
    Effect.sync((): Steering.Drain => {
      const previous = steeringQueue.ledger.get(boundary)
      if (previous !== undefined) {
        return { ...previous, remaining: { items: [...steeringQueue.pending] }, duplicate: true }
      }
      const inserts: Array<ModelRequest.Message> = []
      const seatChanges: Array<Steering.SeatChange | Steering.ThinkingChange> = []
      const keep: Array<Steering.Item> = []
      for (const item of steeringQueue.pending) {
        if (item._tag === "Insert" && item.delivery === "queue" && !wouldIdle) {
          keep.push(item)
          continue
        }
        if (item._tag === "Insert") inserts.push(item.message)
        else seatChanges.push(item)
      }
      steeringQueue.pending = keep
      const record: Steering.DrainRecord = { inserts, seatChanges, queued: false }
      steeringQueue.ledger.set(boundary, record)
      steeringQueue.drained.push(`${boundary} (${inserts.length} inserts)`)
      return { ...record, remaining: { items: keep }, duplicate: false }
    })
})
const pushSteer = (text: string) =>
  steeringQueue.pending.push({
    _tag: "Insert",
    delivery: "steer",
    admittedAt: Date.now(),
    message: ModelRequest.Message.user(text)
  })

// ---------------------------------------------------------------- authorize
/**
 * The permission gate, in the AgentSession shape: decide BEFORE the durable
 * boundary opens, annotate the wait, fail with an encoded PermissionRequired.
 * The request id is derived from the call identity so the resumed replay asks
 * the same question and the grant matches it.
 */
const authorize = (instance: FlowRuntime.FlowInstance["Service"]) => (call: Cell.Call) =>
  Effect.gen(function*() {
    if (!parkBash || call.flowName !== "bash") return
    if (grants.has("bash")) {
      log(`[authorize] bash allowed by session grant`)
      return
    }
    const identity = call.identity
    const requestId = `per_${identity.session}_${identity.frame}_${identity.cell.slice(0, 8)}_${identity.ordinal}`
    log(`[authorize] bash refused; parking with requestId=${requestId}`)
    yield* Effect.provideService(
      FlowRuntime.annotateWaiting({ reason: "approval", token: requestId }),
      FlowRuntime.FlowInstance,
      instance
    )
    return yield* Effect.fail(
      new HarnessError({
        code: "engine_failed",
        message: "Permission required: bash",
        cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
          new Permission.PermissionRequired({
            code: "permission_required",
            requestId,
            runId: instance.executionId,
            capability: Capability.make("proc:spawn", "bash"),
            tier: "irreversible",
            meta: { flow: "bash", input: call.input as never }
          })
        )
      })
    )
  })

// ---------------------------------------------------------------- events
let deltaRun = 0
const flushDeltas = () => {
  if (deltaRun > 0) {
    log(`  model-delta x${deltaRun} (flows.harness.model-delta.v1)`)
    deltaRun = 0
  }
}
const printEvent = (event: AgentEvent.AgentEvent): Effect.Effect<void> =>
  Effect.sync(() => {
    if (event._tag === "model-delta") {
      deltaRun += 1
      return
    }
    flushDeltas()
    let extra = ""
    switch (event._tag) {
      case "cell-produced":
        extra = ` source=${JSON.stringify(event.cell.text).slice(0, 400)}`
        break
      case "cell-printed":
        extra = ` text=${JSON.stringify(event.text).slice(0, 400)}`
        break
      case "cell-settled":
        extra = ` outcome=${JSON.stringify(event.outcome).slice(0, 200)}`
        break
      case "transition-applied":
        extra = ` ${event.transition._tag}`
        break
      case "cell-call-started":
        extra = ` ${event.call.flowName} ${JSON.stringify(event.call.input).slice(0, 80)}`
        break
      case "cell-call-settled":
        extra = ` ${event.flowName} -> ${event.result.outcome} ${JSON.stringify(event.result).slice(0, 200)}`
        break
      case "steering-drained":
        extra = ` messages=${event.messages.length}`
        break
      case "permission-required":
        extra = ` requestId=${event.request.requestId}`
        break
      case "suspended":
        extra = ` code=${event.reason.code}`
        break
      case "turn-closed":
        extra = ` outcome=${event.outcome}`
        break
      case "resolved":
        extra = ` text=${JSON.stringify(assistantText(event.message)).slice(0, 200)}`
        break
      default:
        break
    }
    log(`  ${event._tag} (${event.eventType})${extra}`)
  })

const assistantText = (message: ModelRequest.AssistantMessage): string =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")

// ---------------------------------------------------------------- registration
/**
 * Registers the turn flow with the engine. Everything the body needs is in
 * the registration context: the engine merges it into every execution.
 */
const registration = Layer.effectDiscard(
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const agent = yield* Agent.Agent
    const seats = yield* SeatResolver
    const registry = yield* Registry.Registry
    yield* engine.register(turnFlow, (payload) =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        log(`[body] execution=${instance.executionId} lineage=${instance.lineageId} session=${payload.session}`)
        const seat = yield* seats.resolve(seatId)
        const fsServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
        const shellServices = yield* Effect.context<KernelChildProcessSpawner.ChildProcessSpawner | Path.Path>()
        const engineServices = yield* Effect.context<
          Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
        >()
        let output: string | undefined
        let frames = 0
        yield* agent.run({
          contextWindowTokensFor: contextWindowResolver(seats),
          session: payload.session,
          seat,
          prompt: payload.prompt,
          registry,
          flows: [
            StandardFlows.filesystem(fsServices),
            StandardFlows.shell(shellServices),
            StandardFlows.clock(engineServices)
          ],
          authorize: authorize(instance),
          // Trap: the envelope defaults to "nothing granted", and every std
          // flow is then refused with capability_refused. AgentSession takes
          // it from the approved card; a server declares it for the session.
          capabilityEnvelope: patterns(["fs:read:/**", "fs:write:/**", "proc:spawn:*"]),
          // NodeControl does not export `cellLimits` (it is private to the
          // cli package); these are its values.
          limits: { memoryBytes: 256 * 1024 * 1024, steps: 50_000_000 },
          maxFrames,
          approvalChannel: true,
          // A conversational answer changes no file; the unmoved-tree demand
          // would bounce every completion of this prompt.
          unmovedCap: 0
        }).pipe(
          Stream.runForEach((event) =>
            Effect.suspend(() => {
              if (event._tag === "turn-opened") {
                frames += 1
                output = undefined
                if (steerText !== undefined && frames === 1) {
                  pushSteer(steerText)
                  log(`[steer] queued: ${JSON.stringify(steerText)}`)
                }
              }
              if (event._tag === "transition-applied") {
                output = event.transition._tag === "complete" ? event.transition.output : undefined
              }
              return printEvent(event)
            })
          ),
          Effect.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded(), QuickJSSandbox.layer)),
          Effect.provideService(Steering.Source, steering)
        )
        flushDeltas()
        if (output === undefined) {
          return yield* new HarnessError({
            code: "model_failed",
            message: `The turn ended without a completed answer after ${frames} frames`
          })
        }
        return output
      }).pipe(
        // The flow's error schema is Schema.Unknown; a live HarnessError does
        // not encode, so settle with the package's JSON projection.
        Effect.mapError(settlementFailure),
        Effect.onExit((exit) =>
          Effect.flatMap(FlowRuntime.FlowInstance, (instance) => {
            // A park and a cancel both arrive as an interrupt-only cause;
            // `instance.suspended` is what tells them apart (AgentSession
            // reads it the same way in `settle`).
            const outcome: Outcome = Exit.isSuccess(exit)
              ? { _tag: "completed", output: exit.value }
              : Cause.hasInterruptsOnly(exit.cause)
              ? (instance.suspended ? { _tag: "suspended" } : { _tag: "interrupted" })
              : { _tag: "failed", error: Cause.pretty(exit.cause) }
            const deferred = settled.get(executionId)
            return deferred === undefined ? Effect.void : Effect.asVoid(Deferred.succeed(deferred, outcome))
          })
        )
      ))
  })
)

// ---------------------------------------------------------------- layers
const platform = NodeControl.layerGuardedPlatform(dir)
const spawner = KernelChildProcessSpawner.layer.pipe(
  Layer.provide(NodeControl.layerGrantStore(dir)),
  Layer.provideMerge(platform)
)
const countingHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.tapRequest(client, (request) =>
      Effect.sync(() => {
        providerCalls += 1
        log(`[provider] ${request.method} ${request.url} (call #${providerCalls})`)
      })
    ))
// Trap: NodeHttpClient.layerUndici is not usable under Bun (the undici Agent
// shim has no request/destroy); BunControl uses BunHttpClient.layer.
).pipe(Layer.provide(process.versions.bun === undefined ? NodeHttpClient.layerUndici : BunHttpClient.layer))
const requestExecutor = RequestExecutor.layer.pipe(Layer.provide(countingHttp))
const seats = NodeControl.layerSeatResolver(process.env).pipe(Layer.provide(requestExecutor))
const agent = Agent.layer.pipe(Layer.provide(Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())))
const registry = NodeControl.layerRegistry(dir)
const jj = Jj.layerNoop({
  snapshot: () => Effect.succeed({ changeId: "opencode-spike" }),
  restore: () => Effect.void,
  diff: () => Effect.succeed("")
})
const databaseFile = join(dir, ".smithers", "opencode-spike.sqlite")
// Trap: NodeDatabase refuses to open under Bun (UnsupportedDatabase); the
// runtime entry follows the process, the rest of the stack is identical.
const durableRuntime = process.versions.bun === undefined ? NodeRuntime : BunRuntime
const engine = durableRuntime.layer(
  {
    filename: databaseFile,
    workspaceRoot: dir,
    owner: { hostId: hostname() },
    isAlive: Ownership.sameHostPidProbe
  },
  StepBoundary.layer,
  WorkspaceSandbox.layerFileSystem(),
  registration.pipe(Layer.provide([agent, seats, registry, spawner]))
).pipe(Layer.provide([platform, spawner, NodeCrypto.layer, jj]))

// ---------------------------------------------------------------- driver
const awaitSettled = (id: string) =>
  Effect.gen(function*() {
    const deferred = yield* Deferred.make<Outcome>()
    settled.set(id, deferred)
    return deferred
  })

const awaitParked = (engine: FlowRuntime.FlowRuntime["Service"], id: string, attempts = 200): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const polled = yield* engine.poll(turnFlow, id).pipe(Effect.orDie)
    if (Option.isSome(polled) && polled.value._tag === "Suspended") return true
    if (attempts <= 0) return false
    yield* Effect.sleep("25 millis")
    return yield* awaitParked(engine, id, attempts - 1)
  })

const program = Effect.gen(function*() {
  const engine = yield* FlowRuntime.FlowRuntime
  const state = yield* DurableEngineState.DurableEngineState
  const runs = yield* RunStore.RunStore
  log(`[spike] dir=${dir}`)
  log(`[spike] sqlite=${databaseFile}`)
  log(`[spike] seat=${seatId} session=${session} executionId=${executionId}`)
  log(`[spike] prompt=${JSON.stringify(promptText)} parkBash=${parkBash} steer=${JSON.stringify(steerText)}`)

  // Boot recovery recipe: every parked execution of this flow.
  const parkedOnBoot = yield* state.waitingRuns()
  log(`[boot] waitingRuns=${JSON.stringify(parkedOnBoot)}`)

  const before = yield* engine.poll(turnFlow, executionId).pipe(
    Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(undefined))
  )
  log(`[engine] poll before execute: ${before === undefined ? "not found" : Option.isNone(before) ? "in flight" : before.value._tag}`)

  let deferred = yield* awaitSettled(executionId)
  const t0 = Date.now()
  // Trap: on the durable engine `execute` with `discard: true` returns only
  // after the round settles, so a server forks it (AgentSession's driver does).
  const drive = yield* Effect.forkChild(
    engine.execute(turnFlow, {
      executionId,
      payload: { session, prompt: promptText },
      discard: true
    }).pipe(Effect.tap((returned) =>
      Effect.sync(() => log(`[engine] execute(discard) returned ${JSON.stringify(returned)} after ${Date.now() - t0} ms`))
    ))
  )
  if (interruptAfterMs !== undefined) {
    yield* Effect.forkChild(
      Effect.sleep(`${interruptAfterMs} millis`).pipe(
        Effect.andThen(Effect.sync(() => log(`[interrupt] engine.interrupt(${executionId}) at ${Date.now() - t0} ms`))),
        Effect.andThen(engine.interrupt(turnFlow, executionId)),
        Effect.tap(() => Effect.sync(() => log(`[interrupt] durable cancel recorded`)))
      )
    )
  }

  // A completed execution re-executed under the same id never runs the body:
  // race the body's exit against the engine's published result.
  let outcome = yield* Effect.raceFirst(
    Deferred.await(deferred),
    Effect.gen(function*() {
      for (;;) {
        // The forked execute may not have created the row yet.
        const polled = yield* engine.poll(turnFlow, executionId).pipe(
          Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(Option.none()))
        )
        if (Option.isSome(polled) && polled.value._tag === "Complete") {
          const exit = polled.value.exit
          return Exit.isSuccess(exit)
            ? { _tag: "completed", output: `${exit.value}` } satisfies Outcome
            : { _tag: "failed", error: Cause.pretty(exit.cause) } satisfies Outcome
        }
        if (Option.isSome(polled) && polled.value._tag === "Suspended") {
          // Let the body's own exit report the park.
          yield* Effect.sleep("2 seconds")
          return { _tag: "suspended" } satisfies Outcome
        }
        yield* Effect.sleep("50 millis")
      }
    })
  )
  log(`[engine] first drive settled: ${outcome._tag} after ${Date.now() - t0} ms, providerCalls=${providerCalls}`)

  if (outcome._tag === "suspended") {
    const parked = yield* awaitParked(engine, executionId)
    const row = yield* runs.get(executionId).pipe(Effect.orDie)
    const waiting = yield* state.waiting(executionId)
    log(`[park] engine.poll says parked=${parked}`)
    log(`[park] run row: status=${row.status} owner=${row.owner === null ? "null" : "set"} claim=${row.claim === null ? "null" : "set"}`)
    log(`[park] waiting row: ${JSON.stringify(Option.getOrUndefined(waiting))}`)
    log(`[park] waitingRuns(approval): ${JSON.stringify(yield* state.waitingRuns({ reason: "approval" }))}`)
    // The person answers "once" / "always": install the grant, re-drive the
    // same execution id.
    grants.add("bash")
    log(`[grant] bash granted for session; resuming execution ${executionId}`)
    deferred = yield* awaitSettled(executionId)
    const callsBeforeResume = providerCalls
    yield* engine.resume(turnFlow, executionId)
    outcome = yield* Deferred.await(deferred)
    log(`[engine] resumed drive settled: ${outcome._tag}; provider calls during resume=${providerCalls - callsBeforeResume}`)
  }

  if (outcome._tag === "interrupted") {
    const row = yield* runs.get(executionId).pipe(Effect.orDie)
    log(`[interrupt] body fiber interrupted; run row status=${row.status}`)
  }
  const final = yield* engine.poll(turnFlow, executionId).pipe(Effect.orDie)
  log(`[engine] final poll: ${Option.isNone(final) ? "in flight" : final.value._tag}${
    Option.isSome(final) && final.value._tag === "Complete" ? ` exit=${final.value.exit._tag}` : ""
  }`)
  // An interrupted drive joins as an interrupt; read it as an exit.
  yield* Effect.exit(Effect.timeout(Fiber.join(drive), "10 seconds"))
  log(`[result] ${JSON.stringify(outcome)}`)
  log(`[steering] drains=${JSON.stringify(steeringQueue.drained)}`)
  log(`[provider] total calls=${providerCalls}`)
  return outcome
})

const outcome = await program.pipe(
  Effect.provide(engine),
  Effect.scoped,
  Effect.runPromise
)
process.exit(outcome._tag === "completed" || outcome._tag === "interrupted" ? 0 : 1)
```

