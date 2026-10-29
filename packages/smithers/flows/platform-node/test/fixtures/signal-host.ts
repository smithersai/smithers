/**
 * A host program that shuts down on a signal, for the integration test to kill.
 *
 * It is a separate process on purpose. `SIGTERM` to a Vitest worker is not the
 * thing under test — a real deployment sends the signal to a program that owns
 * its process — and the only honest way to observe what that program leaves in
 * the database is to be a different process from it.
 *
 * Usage: `node signal-host.ts <sqlite file> <executionId> [hang] [timeoutMs]`.
 * It prints the run's status once the run is actually running, then waits to be
 * signalled. In `hang` mode the action's interruption never returns, so the
 * graceful shutdown cannot finish and the handler's escapes are the only way
 * this process ever exits.
 */
import { Action, Flow, Interpreter, RunStore as RunStorePackage } from "@smthrs/flows"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as NodeRuntime from "../../src/NodeRuntime.ts"

const { RunStore } = RunStorePackage

const filename = process.argv[2]
const executionId = process.argv[3]
const hang = process.argv[4] === "hang"
const shutdownTimeoutMs = process.argv[5] === undefined ? undefined : Number(process.argv[5])
if (filename === undefined || executionId === undefined) {
  throw new Error("usage: signal-host.ts <sqlite file> <executionId> [hang] [timeoutMs]")
}

const Probe = Action.make("flows/signal/probe", {
  payload: { what: Schema.String },
  success: Schema.String
})

const Host = Flow.make("flows/signal/host", {
  payload: { what: Schema.String },
  success: Schema.String,
  body: (payload) => Probe.call(payload)
})

/**
 * A body that cannot be shut down.
 *
 * `Effect.onInterrupt` runs uninterruptibly, so an interruption handler that
 * never returns is a finalizer that never returns, which is exactly the
 * shutdown a host has to be able to walk away from.
 */
const probe = () =>
  hang
    ? Effect.as(Effect.sleep("10 minutes"), "woke").pipe(Effect.onInterrupt(() => Effect.never))
    : Effect.as(Effect.sleep("10 minutes"), "woke")

const flows = Interpreter.layer(Host).pipe(
  Layer.provideMerge(Probe.toLayer(probe)),
  Layer.provideMerge(Action.layerImplementations)
)

/**
 * In `hang` mode the process must not be allowed to fall out of its own event
 * loop: Node exits an unsettled top-level `await` with status 13, which would
 * hide the escapes under test behind an accident. A real host holds sockets,
 * watchers, and pools; this is the smallest stand-in for them.
 */
const keepAlive = hang ? setInterval(() => {}, 60_000) : undefined

const program = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  const running = yield* Effect.forkChild(
    Effect.exit(Host.execute({ what: "sleep" }, { executionId })),
    { startImmediately: true }
  )
  let row = yield* runs.get(executionId)
  for (let attempt = 0; attempt < 400 && row.status !== "running"; attempt++) {
    yield* Effect.sleep("25 millis")
    row = yield* runs.get(executionId)
  }
  yield* Effect.sync(() => {
    process.stdout.write(`STATUS=${row.status}\n`)
  })
  yield* Effect.exit(Fiber.join(running))
}).pipe(
  Effect.provide(
    NodeRuntime.layerHost(
      {
        filename,
        workspaceRoot: process.cwd(),
        owner: { hostId: "signal-host" },
        ...shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }
      },
      flows
    )
  ),
  Effect.scoped
)

await Effect.runPromise(Effect.exit(program))
if (keepAlive !== undefined) clearInterval(keepAlive)
