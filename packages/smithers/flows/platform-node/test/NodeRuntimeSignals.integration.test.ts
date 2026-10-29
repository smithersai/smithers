/**
 * What a `SIGTERM` leaves behind.
 *
 * A host that is killed while it drives a run has one job: leave the run
 * reclaimable. `layerHost` installs the handler that does it, and the handler
 * closes the runtime scope rather than killing the process, so the engine's
 * own release path runs and the row ends `suspended` with a `released` reason
 * instead of `running` behind a dead owner until a sweep notices.
 *
 * The program under test is a real child process (`test/fixtures/signal-host.ts`).
 * Sending `SIGTERM` to this worker would test Vitest, and reading the database
 * from inside the process that wrote it would prove nothing about what
 * survived the shutdown.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const directory = mkdtempSync(join(tmpdir(), "flows-signal-host-"))
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "signal-host.ts")

afterAll(() => rmSync(directory, { recursive: true, force: true }))

interface Shutdown {
  readonly announced: string
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
}

/** Runs the host, waits for it to announce a running run, then signals it. */
const shutdown = (
  filename: string,
  executionId: string,
  signal: NodeJS.Signals,
  options?: { readonly hang?: boolean; readonly shutdownTimeoutMs?: number; readonly signals?: number }
): Promise<Shutdown> =>
  new Promise((resolve, reject) => {
    const argv = [fixture, filename, executionId]
    if (options?.hang === true) argv.push("hang")
    if (options?.shutdownTimeoutMs !== undefined) argv.push(String(options.shutdownTimeoutMs))
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] })
    let announced = ""
    let stderr = ""
    let signalled = false
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`the host never announced a running run: ${stderr}`))
    }, 60_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      announced += chunk
      if (!signalled && /^STATUS=running\r?$/m.test(announced)) {
        signalled = true
        for (let sent = 0; sent < (options?.signals ?? 1); sent++) {
          // The second signal has to arrive after the first was handled, or
          // the handler has not yet had anything to be asked twice about.
          setTimeout(() => child.kill(signal), sent * 250)
        }
      }
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("exit", (code, exitSignal) => {
      clearTimeout(timer)
      resolve({
        announced: /^STATUS=(.*)\r?$/m.exec(announced)?.[1] ?? announced.trim(),
        code,
        signal: exitSignal,
        stderr
      })
    })
  })

const readBack = <A>(filename: string, query: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(filename, { readOnly: true })
  try {
    return query(database)
  } finally {
    database.close()
  }
}

describe("a signalled host", () => {
  it("releases the run it was driving and exits on its own", async () => {
    const filename = join(directory, "signal", "runtime.sqlite")

    const result = await shutdown(filename, "signal-run", "SIGTERM")

    // The child only signals itself once the run is genuinely running, so a
    // release below cannot be a run that never started.
    expect(result.announced).toBe("running")
    // The handler shuts the runtime down; it does not let the default
    // behavior kill the process, which would leave the row `running`.
    expect(result.signal).toBeNull()
    expect(
      readBack(
        filename,
        (database) =>
          database.prepare("SELECT status, waiting_reason, owner_host_id FROM flows_runs WHERE run_id = 'signal-run'")
            .get()
      )
    ).toMatchObject({ status: "suspended", waiting_reason: "released", owner_host_id: null })
  }, 120_000)

  it("leaves on a second signal when the graceful shutdown will not finish", async () => {
    // Installing a handler removes Node's default signal behavior. Without an
    // escape, a finalizer that never returns turns Ctrl-C into a program that
    // cannot be stopped by anything short of `SIGKILL`.
    const filename = join(directory, "second", "runtime.sqlite")

    const result = await shutdown(filename, "second-signal", "SIGTERM", {
      hang: true,
      // Long enough that the deadline cannot be what ended this process.
      shutdownTimeoutMs: 120_000,
      signals: 2
    })

    expect(result.announced).toBe("running")
    // The status the default behavior would have produced: 128 + SIGTERM.
    expect(result.code).toBe(143)
    expect(result.signal).toBeNull()
  }, 120_000)

  it("leaves when a graceful shutdown outlasts its deadline", async () => {
    const filename = join(directory, "deadline", "runtime.sqlite")

    const result = await shutdown(filename, "deadline-signal", "SIGTERM", {
      hang: true,
      shutdownTimeoutMs: 1000
    })

    expect(result.announced).toBe("running")
    expect(result.code).toBe(143)
    expect(result.signal).toBeNull()
  }, 120_000)
})
