/**
 * Recover process cleanup after a host is killed with SIGKILL.
 *
 * The host records each spawned process group in the durable `ProcessLedger`. A
 * later incarnation of the same host ID inspects those records, reaps groups
 * whose owner is gone, and journals the result.
 *
 * The companion host program runs in a separate process so the example can kill
 * it without running its finalizers. This exercises recovery that a graceful
 * shutdown would not test.
 */
import { Journal, Kernel } from "@smthrs/flows"
import { NodeHost, NodeRuntime } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Stream from "effect/Stream"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The host id both incarnations share. It is what makes the records theirs.
 * @since 1.0.0-rc.0
 * @category constants
 */
export const hostId = "examples/host-containment"

const hostProgram = join(dirname(fileURLToPath(import.meta.url)), "37-host-containment-host.ts")

/**
 * Observations from the killed host and its replacement.
 * @since 1.0.0-rc.0
 * @category models
 */
export interface Summary {
  /** Diagnostics from the host before it was killed, including Node runtime warnings. */
  readonly hostStderr: string
  /** The process group the killed host started. */
  readonly pgid: number
  /** Whether that group survived the host, which is the problem to solve. */
  readonly orphaned: boolean
  /** Whether it survived the next incarnation, which is the answer. */
  readonly survivedTheReaper: boolean
  /** What the host's own journal run records, in order. */
  readonly hostEvents: ReadonlyArray<string>
}

const groupIsAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Runs the host until it reports the group it started, kills it, and waits for
 * the operating system to reap it so its pid genuinely reads as gone. Startup
 * has a 30-second deadline; scope release always terminates and reaps the host.
 */
export const killHost = (filename: string, reap: Effect.Effect<unknown>) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // Even a rejected launch must sweep durable records from a previous host.
    // Child cleanup is registered later and therefore runs before this reaper.
    yield* Effect.addFinalizer(() => reap)
    // Acquisition installs cleanup before startup becomes interruptible. The
    // reaper runs only after the OS has reaped the host, even on interruption.
    const host = yield* Effect.acquireRelease(
      spawner.spawn(
        ChildProcess.make(process.execPath, [
          "--import",
          import.meta.resolve("vibelang/register"),
          hostProgram,
          filename,
          hostId
        ], {
          stdin: "ignore",
          killSignal: "SIGKILL"
        })
      ),
      (host) =>
        Effect.gen(function*() {
          if (yield* host.isRunning) yield* host.kill({ killSignal: "SIGKILL" })
          yield* host.exitCode.pipe(Effect.ignore)
        }).pipe(Effect.orDie)
    )
    let stderr = ""
    const diagnostics = yield* host.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderr += chunk
        })
      ),
      Effect.orDie,
      Effect.forkScoped
    )
    const announced = yield* host.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("30 seconds"),
      Effect.orDie
    )
    if (announced.length === 0) {
      yield* host.exitCode.pipe(Effect.ignore)
      yield* Fiber.join(diagnostics)
      return yield* Effect.die(new Error(`the host exited before announcing a group: ${stderr}`))
    }
    const pgid = Number(announced[0])
    if (!Number.isSafeInteger(pgid) || pgid <= 0) {
      return yield* Effect.die(new Error(`the host announced an invalid group: ${announced[0]}`))
    }
    // No handler runs for this, which is the whole point.
    yield* host.kill({ killSignal: "SIGKILL" }).pipe(Effect.orDie)
    yield* host.exitCode.pipe(Effect.ignore)
    yield* Fiber.join(diagnostics)
    return { pgid, hostStderr: stderr }
  }).pipe(Effect.orDie)

/** Waits until `pgid` is gone, or gives up after `budgetMs`. */
const waitForGroupExit = (pgid: number, budgetMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const deadline = Date.now() + budgetMs
    const poll = () => {
      if (!groupIsAlive(pgid)) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(poll, 25)
    }
    poll()
  })

/**
 * Starts, kills, and replaces a host over the same durable journal.
 * @since 1.0.0-rc.0
 * @category examples
 */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    // --------------------------------------------------------------- restart
    // A new host, given nothing about the dead one but its id. Building the
    // layer IS the sweep: the reaper runs while the host stands up, so by the
    // time this body runs the decision has already been made and journaled.
    let hostEvents: ReadonlyArray<string> = []
    const reap = Effect.gen(function*() {
      const journal = yield* Journal.Journal.Journal
      const page = yield* journal.entries({
        runId: Kernel.ProcessLedger.hostRunId(hostId),
        limit: 16
      })
      return page.entries.map((entry) => entry.eventType)
    }).pipe(
      Effect.provide(
        NodeRuntime.layerHost(
          { filename, workspaceRoot: dirname(filename), owner: { hostId }, signals: [] },
          Layer.empty
        )
      ),
      Effect.orDie,
      Effect.scoped,
      Effect.tap((events) =>
        Effect.sync(() => {
          hostEvents = events
        })
      )
    )

    // Scope release is uninterruptible and runs on success, failure, and
    // interruption, including startup before any PID has been announced.
    const { pgid, hostStderr, orphaned } = yield* Effect.gen(function*() {
      const host = yield* killHost(filename, reap)
      return { ...host, orphaned: groupIsAlive(host.pgid) }
    }).pipe(Effect.scoped)

    const survivedTheReaper = !(yield* Effect.promise(() => waitForGroupExit(pgid, 10_000)))
    return { pgid, hostStderr, orphaned, survivedTheReaper, hostEvents }
  }).pipe(Effect.provide(NodeHost.NodeChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.mergeAll(NodeHost.NodeFileSystem.layer, NodeHost.NodePath.layer))
  )))
