/** Wait for the real RPC route while owning the child until startup succeeds. */
import type { ChildProcess } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

/**
 * Probe the RPC route itself: TCP accepts before the router mounts, and a 404
 * means startup is still in progress. A deadline covers response headers, body
 * consumption and time between probes.
 * Any failure before the caller receives ownership kills and reaps the child.
 */
export async function waitForServe(child: ChildProcess, { port, timeoutMs, command, output, signal }: {
  readonly port: number
  readonly timeoutMs: number
  readonly command: string
  readonly output: () => string
  readonly signal?: AbortSignal | undefined
}): Promise<void> {
  const deadline = new AbortController()
  const timer = setTimeout(() =>
    deadline.abort(
      new Error(
        "smthrs serve never answered on " + port + " within " + timeoutMs + "ms"
      )
    ), timeoutMs)
  const startup = signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal
  let onError!: (error: Error) => void
  let onClose!: (code: number | null, signal: NodeJS.Signals | null) => void
  let onAbort!: () => void
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const failed = new Promise((_, reject) => {
    onError = reject
    onClose = (code, signal) =>
      reject(
        new Error(
          "smthrs serve exited with " + (signal ?? String(code)) + " before it served"
        )
      )
    onAbort = () => reject(startup.reason)
    child.once("error", onError)
    child.once("close", onClose)
    startup.addEventListener("abort", onAbort, { once: true })
    if (startup.aborted) onAbort()
  })
  const probe = async () => {
    for (;;) {
      startup.throwIfAborted()
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/rpc", {
          method: "POST",
          headers: { "content-type": "application/ndjson" },
          body: "\n",
          signal: startup
        })
        await response.text()
        startup.throwIfAborted()
        if (response.status !== 404) return
      } catch (error) {
        if (startup.aborted) throw error
      }
      await delay(100, undefined, { signal: startup })
    }
  }
  try {
    await Promise.race([probe(), failed])
  } catch (error) {
    child.kill("SIGKILL")
    await closed
    throw new Error(String(error) + "\n" + command + "\n" + output(), { cause: error })
  } finally {
    clearTimeout(timer)
    // Stop an in-flight probe even when child exit or spawn failure won the race.
    deadline.abort()
    child.off("error", onError)
    child.off("close", onClose)
    startup.removeEventListener("abort", onAbort)
  }
}
