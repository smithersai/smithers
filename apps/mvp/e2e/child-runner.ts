import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"

/** A process-group receipt: direct-child exit is insufficient while its Playwright workers are still alive. */
export const runChild = (command: string, args: ReadonlyArray<string>, options: {
  readonly env?: NodeJS.ProcessEnv
  readonly capture?: boolean
  readonly signal?: AbortSignal
  readonly log?: (line: string) => void
  readonly killAfterMs?: number
} = {}): Promise<{ status: number; stdout: string; stderr: string }> => new Promise((accept, reject) => {
  options.signal?.throwIfAborted()
  const child = spawn(command, [...args], { env: options.env, detached: true, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit" })
  let timer: ReturnType<typeof setTimeout> | undefined
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => { stdout += chunk })
  child.stderr?.on("data", (chunk) => { stderr += chunk })
  const stop = () => {
    if (!child.pid || timer) return
    const pid = child.pid
    try { process.kill(-pid, "SIGINT") } catch {}
    timer = setTimeout(() => { try { process.kill(-pid, "SIGKILL") } catch {} }, options.killAfterMs ?? 30_000)
    timer.unref()
  }
  options.signal?.addEventListener("abort", stop, { once: true })
  const cleanup = () => {
    options.signal?.removeEventListener("abort", stop)
    if (timer) clearTimeout(timer)
  }
  child.once("error", (error) => { cleanup(); reject(error) })
  child.once("close", async (status) => {
    try {
      if (child.pid) {
        let waiting = false
        for (;;) {
          try { process.kill(-child.pid, 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") break
            throw error
          }
          if (!waiting) { options.log?.(`[e2e-child] waiting for owned process group ${child.pid} after ${command} exited`); waiting = true }
          await delay(50)
        }
      }
      cleanup()
      accept({ status: status ?? 1, stdout, stderr })
    } catch (error) { cleanup(); reject(error) }
  })
})
