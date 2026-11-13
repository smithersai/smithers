/**
 * Starts the worker under workerd and asserts one cell ran inside it.
 *
 * See `docs/guides/workerd.md#run-the-wrangler-smoke` for the dependency
 * installation and direct or opt-in Vitest commands. This directory is not a
 * pnpm workspace member; Wrangler supplies its workerd binary.
 *
 * The assertion is the whole point: workerd refuses `WebAssembly.compile` over
 * bytes, so a `complete` transition here can only have come from the module the
 * toolchain compiled and the worker named.
 */
import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const port = Number(process.env.FLOWS_WORKERD_PORT ?? 0)
const startupMs = Number(process.env.FLOWS_WORKERD_STARTUP_MS ?? 120_000)
const expected = "README.md"

const directory = new URL(".", import.meta.url)

// Said here rather than left to Node, whose "module not found" does not name
// the one command that fixes it.
if (!existsSync(new URL("node_modules/wrangler", directory))) {
  process.stderr.write("wrangler is not installed. Run `npm ci` in packages/smithers/agent/harness/test/workerd first.\n")
  process.exit(1)
}

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("node_modules/wrangler/bin/wrangler.js", directory)),
    "dev", "--ip", "127.0.0.1", "--port", String(port)],
  {
    cwd: directory,
    detached: process.platform !== "win32",
    // `CI` is what turns off wrangler's interactive dev session, which would
    // otherwise hold the terminal and never exit under a test runner.
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  }
)

let log = ""
child.stdout.on("data", (chunk) => {
  log += chunk
})
child.stderr.on("data", (chunk) => {
  log += chunk
})

let exited
const closed = new Promise((resolve) => child.once("close", resolve))
child.on("exit", (code) => {
  exited = code ?? 1
})
child.on("error", (error) => {
  exited = 1
  log += `\nFailed to start wrangler: ${error.message}\n`
})

// On POSIX, Wrangler and workerd share this process group. Stop the group
// even when the parent has already exited but a descendant still listens.
const signalGroup = (signal) => {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}
let stopping
const stop = () => stopping ??= (async () => {
  if (child.pid !== undefined) {
    if (process.platform === "win32") {
      try {
        await promisify(execFile)("taskkill", ["/pid", String(child.pid), "/T", "/F"])
      } catch (error) {
        // taskkill reports an already-stopped tree with exit code 128.
        if (error.code !== 128) throw error
      }
    } else {
      signalGroup("SIGTERM")
      await delay(200)
      signalGroup("SIGKILL")
    }
  }
  await closed
})()

let interruptionCode
for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]]) {
  process.on(signal, async () => {
    interruptionCode ??= code
    await stop()
    process.exit(interruptionCode)
  })
}

const fail = async (message) => {
  await stop()
  process.stderr.write(`${message}\n\nwrangler output:\n${log}\n`)
  process.exit(interruptionCode ?? 1)
}

/** Polls until the worker answers, because wrangler reports ready before it is. */
const answer = async () => {
  const deadline = Date.now() + startupMs
  while (Date.now() < deadline) {
    if (exited !== undefined) return undefined
    // Only Wrangler's own ready record identifies the listener we started.
    // Never probe the requested port before that record: it may belong to
    // an unrelated dev server while this child is still starting.
    const url = log.match(/Ready on (http:\/\/127\.0\.0\.1:[1-9]\d*)/)?.[1]
    if (url !== undefined) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now())))
        })
        return { status: response.status, body: await response.text() }
      } catch {
        // Connection startup and a stalled response both consume the same
        // finite startup budget, including reading the response body.
      }
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())))
  }
  return undefined
}

try {
  const result = await answer()
  if (result === undefined) {
    await fail(
      exited === undefined
        ? `The worker did not answer within ${startupMs} ms.`
        : `wrangler exited with code ${exited} before the worker answered.`
    )
  }

  if (result.status !== 200) await fail(`The worker answered ${result.status}: ${result.body}`)
  let outcome
  try {
    outcome = JSON.parse(result.body)
  } catch {
    await fail(`The worker did not return JSON: ${result.body}`)
  }
  if (
    outcome?._tag !== "settled" || outcome.transition?._tag !== "complete" ||
    outcome.transition.output !== expected
  ) {
    await fail(`The cell did not complete inside workerd. The worker answered: ${result.body}`)
  }

  await stop()
  if (interruptionCode !== undefined) process.exit(interruptionCode)
  process.stdout.write(`workerd smoke passed: ${result.body}\n`)
} finally {
  await stop()
}
