/** Bounded subprocess capture for disposable installed-package release probes. */
import { execFile } from "node:child_process"

/**
 * Waits for stdout/stderr to close, not just for the child to exit. A broken
 * import must not hang the release gate or buffer unlimited diagnostic output.
 */
export const captureProcess = (command, args, cwd, { timeoutMs = 120_000, maxOutputBytes = 1024 * 1024, env = process.env } = {}) =>
  new Promise((resolve) => {
    const child = execFile(command, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      killSignal: "SIGKILL"
    }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        output: stdout + stderr + (error === null ? "" : `\n${error.message}`)
      })
    })
    child.stdin?.end()
  })
