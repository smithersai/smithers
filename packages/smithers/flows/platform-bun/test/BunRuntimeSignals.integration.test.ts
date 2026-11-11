/**
 * What a `SIGTERM` leaves behind when a Bun program runs on
 * `BunRuntime.layerHost`.
 *
 * `layerHost` is the documented Bun entry point: it installs the signal
 * handlers, the shutdown deadline and the contained host. The program under
 * test is a real Bun child process (`test/fixtures/signal-host.bun.ts`), so the
 * signal reaches a program that owns its process and the database is read back
 * by a different process from the one that wrote it.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = join(packageDirectory, "test", "fixtures", "signal-host.bun.ts")
// The Bun lane always runs these; a Node run without Bun installed skips them.
const bun = process.versions.bun === undefined ? "bun" : process.execPath
const bunLane = process.env.SMITHERS_PLATFORM_BUN_LANE === "1"
const bunInstalled = bunLane || spawnSync(bun, ["--version"], { stdio: "ignore" }).status === 0
const directory = mkdtempSync(join(tmpdir(), "flows-bun-signal-host-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

interface Shutdown {
  readonly announced: string
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stderr: string
}

/** Runs the Bun host, waits for it to announce a running run, then signals it. */
const shutdown = (
  filename: string,
  executionId: string,
  options?: { readonly hang?: boolean; readonly shutdownTimeoutMs?: number; readonly signals?: number }
): Promise<Shutdown> =>
  new Promise((resolve, reject) => {
    const argv = [fixture, filename, executionId]
    if (options?.hang === true) argv.push("hang")
    if (options?.shutdownTimeoutMs !== undefined) argv.push(String(options.shutdownTimeoutMs))
    // The package directory holds the bunfig.toml whose preload loads VibeLang sources.
    const child = spawn(bun, argv, { cwd: packageDirectory, stdio: ["ignore", "pipe", "pipe"] })
    let announced = ""
    let stderr = ""
    let signalled = false
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`the Bun host never announced a running run: ${stderr}`))
    }, 60_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      announced += chunk
      if (!signalled && /^STATUS=running\r?$/m.test(announced)) {
        signalled = true
        for (let sent = 0; sent < (options?.signals ?? 1); sent++) {
          // The second signal has to arrive after the first was handled.
          setTimeout(() => child.kill("SIGTERM"), sent * 250)
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

const runRow = (filename: string, executionId: string) => {
  const database = new DatabaseSync(filename, { readOnly: true })
  try {
    return database.prepare("SELECT status, waiting_reason, owner_host_id FROM flows_runs WHERE run_id = ?")
      .get(executionId)
  } finally {
    database.close()
  }
}

describe.skipIf(!bunInstalled || process.platform === "win32")("a signalled BunRuntime.layerHost program", () => {
  it("releases the run it was driving and exits on its own", async () => {
    const filename = join(directory, "signal", "runtime.sqlite")

    const result = await shutdown(filename, "bun-signal-run")

    expect(result.announced, result.stderr).toBe("running")
    // The handler closes the runtime scope; the default signal behavior would
    // kill the process and leave the row `running`.
    expect(result.signal).toBeNull()
    expect(result.code, result.stderr).toBe(0)
    expect(runRow(filename, "bun-signal-run")).toMatchObject({
      status: "suspended",
      waiting_reason: "released",
      owner_host_id: null
    })
  }, 120_000)

  it("leaves on a second signal when the graceful shutdown will not finish", async () => {
    const filename = join(directory, "second", "runtime.sqlite")

    const result = await shutdown(filename, "bun-second-signal", {
      hang: true,
      // Long enough that the deadline cannot be what ended this process.
      shutdownTimeoutMs: 120_000,
      signals: 2
    })

    expect(result.announced, result.stderr).toBe("running")
    expect(result.code).toBe(143)
    expect(result.signal).toBeNull()
  }, 120_000)

  it("leaves when a graceful shutdown outlasts its deadline", async () => {
    const filename = join(directory, "deadline", "runtime.sqlite")

    const result = await shutdown(filename, "bun-deadline-signal", { hang: true, shutdownTimeoutMs: 1000 })

    expect(result.announced, result.stderr).toBe("running")
    expect(result.code).toBe(143)
    expect(result.signal).toBeNull()
  }, 120_000)
})
