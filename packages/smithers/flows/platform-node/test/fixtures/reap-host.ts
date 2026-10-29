/**
 * A host program that starts a process group and then waits to be killed.
 *
 * It exists to be `SIGKILL`ed. A host that is signalled runs its finalizers and
 * takes its children with it; a host that is KILLED runs nothing, and what it
 * spawned survives with nobody holding a handle to it. That is the only state
 * in which the `ProcessReaper` has anything to do, and the only honest way to
 * produce it is to kill a real host process from outside.
 *
 * Usage: `node reap-host.ts <sqlite file> <hostId> <executionId>`. It prints the
 * pid of the process group it started, then waits.
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Action, Flow, Interpreter } from "@smthrs/flows"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import * as NodeRuntime from "../../src/NodeRuntime.ts"

const filename = process.argv[2]
const hostId = process.argv[3]
const executionId = process.argv[4]
if (filename === undefined || hostId === undefined || executionId === undefined) {
  throw new Error("usage: reap-host.ts <sqlite file> <hostId> <executionId>")
}

/** Starts a two-process tree in its own group and never comes back. */
const Spawn = Action.make({
  name: "flows/reap/spawn",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: "flows/reap/spawn/v1",
  execute: Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* Effect.orDie(spawner.spawn(ChildProcess.make("sh", ["-c", "sleep 300 & sleep 300"])))
    // Printed only after the spawn returned, which is after the ledger wrote
    // the record: the test may kill this process the moment it reads the line.
    process.stdout.write(`SPAWNED=${handle.pid as number}\n`)
    yield* Effect.orDie(handle.exitCode)
    return "woke"
  })
})

const Probe = Action.make("flows/reap/probe", {
  payload: { what: Schema.String },
  success: Schema.String
})

const Host = Flow.make("flows/reap/host", {
  payload: { what: Schema.String },
  success: Schema.String,
  body: (payload) => Probe.call(payload)
})

const flows = Interpreter.layer(Host).pipe(
  Layer.provideMerge(Probe.toLayer(() => Spawn)),
  Layer.provideMerge(Action.layerImplementations)
)

const program = Host.execute({ what: "spawn" }, { executionId }).pipe(
  Effect.provide(
    NodeRuntime.layerHost(
      {
        filename,
        workspaceRoot: process.cwd(),
        owner: { hostId },
        signals: [],
        rules: [
          new Permission.Rule({
            effect: "allow",
            pattern: new Capability.CapabilityPattern({ action: "proc:spawn", resource: "*" })
          })
        ]
      },
      flows
    )
  ),
  Effect.scoped
)

await Effect.runPromise(Effect.exit(program))
