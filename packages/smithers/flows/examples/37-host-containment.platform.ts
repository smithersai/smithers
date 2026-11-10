// The platform code of 37-host-containment.vibe, which a .vibe file does not import as a value (EK4402).

import { NodeRuntime } from "@smthrs/platform-node"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const hostProgram = join(dirname(fileURLToPath(import.meta.url)), "37-host-containment-host.ts")

/**
 * Whether a process group still exists.
 *
 * @throws {never}
 */
export const groupIsAlive = (pgid: number): boolean => {
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
export const killHost = (filename: string, hostId: string, reap: Effect.Effect<unknown>) =>
  Effect.gen(function*() {
    // Only spawn is uninterruptible. Waiting for startup happens after the
    // finalizer is installed, so interruption can never abandon the child.
    const host = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const child = spawn(process.execPath, [hostProgram, filename, hostId], { stdio: ["ignore", "pipe", "pipe"] })
        const host = {
          child,
          closed: false,
          stopped: new Promise<void>((resolve) => {
            // Keep errors handled even if startup's listeners are removed by
            // interruption before termination finishes.
            const onError = () => {}
            child.on("error", onError)
            child.once("close", () => {
              host.closed = true
              child.off("error", onError)
              resolve()
            })
          })
        }
        return host
      }),
      (host) =>
        Effect.promise(async () => {
          if (!host.closed) host.child.kill("SIGKILL")
          // The ledger reaper must see a dead owner, not a host still exiting.
          await host.stopped
        }).pipe(Effect.ensuring(reap))
    )

    return yield* Effect.callback<{ readonly pgid: number; readonly hostStderr: string }>((resume) => {
      const { child } = host
      let announced = ""
      let stderr = ""
      let pgid: number | undefined
      const cleanup = () => {
        child.stdout.off("data", onData)
        child.stderr.off("data", onStderr)
        child.off("error", onError)
        child.off("close", onClose)
      }
      const onError = (error: Error) => {
        cleanup()
        resume(Effect.die(error))
      }
      const onData = (chunk: string) => {
        announced += chunk
        if (pgid === undefined && announced.includes("\n")) {
          const announcedPgid = Number(announced.split("\n")[0])
          if (!Number.isSafeInteger(announcedPgid) || announcedPgid <= 0) {
            onError(new Error(`the host announced an invalid group: ${announced}`))
            return
          }
          pgid = announcedPgid
          // No handler runs for this, which is the whole point.
          child.kill("SIGKILL")
        }
      }
      const onStderr = (chunk: string) => {
        stderr += chunk
      }
      const onClose = () => {
        cleanup()
        resume(
          pgid === undefined
            ? Effect.die(new Error(`the host exited before announcing a group: ${stderr}`))
            : Effect.succeed({ pgid, hostStderr: stderr })
        )
      }
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", onData)
      child.stderr.on("data", onStderr)
      child.on("error", onError)
      child.on("close", onClose)
      if (host.closed) onClose()
      return Effect.sync(cleanup)
    }).pipe(Effect.timeout("30 seconds"), Effect.orDie)
  })

/** Waits until `pgid` is gone, or gives up after `budgetMs`. */
export const waitForGroupExit = (pgid: number, budgetMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const deadline = Date.now() + budgetMs
    const poll = () => {
      if (!groupIsAlive(pgid)) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(poll, 25)
    }
    poll()
  })

/** The host both incarnations run as, over the same durable journal. */
export const hostLayer = (filename: string, hostId: string) =>
  NodeRuntime.layerHost(
    { filename, workspaceRoot: dirname(filename), owner: { hostId }, signals: [] },
    Layer.empty
  )
