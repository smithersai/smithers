/** Bounded child groups for bootstrap automation; cancellation waits for this invocation's children. */
import { spawn } from "node:child_process"

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, stream?: boolean}} [options]
 * @returns {Promise<{status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string}>}
 */
export function runProcess(command, args, { cwd, env = process.env, signal, timeoutMs = 60000, maxBytes = 32 * 1024 * 1024, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    const stdout = [], stderr = []
    let bytes = 0, failure, escalation
    const kill = (name) => { if (child.pid) { try { process.kill(-child.pid, name) } catch (error) { if (error.code !== "ESRCH") failure ??= error } } }
    const stop = (error) => {
      if (failure) return
      failure = error
      kill("SIGTERM")
      escalation = setTimeout(() => kill("SIGKILL"), 3000)
    }
    const abort = () => stop(signal.reason ?? new Error("Command interrupted"))
    const timeout = setTimeout(() => stop(new Error(`Command timed out after ${timeoutMs}ms: ${command}`)), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    const collect = (chunks, output, chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) stop(new Error(`Command output exceeded ${maxBytes} bytes: ${command}`))
      else chunks.push(chunk)
      if (stream) output.write(chunk)
    }
    child.stdout.on("data", (chunk) => collect(stdout, process.stdout, chunk))
    child.stderr.on("data", (chunk) => collect(stderr, process.stderr, chunk))
    const cleanup = () => { clearTimeout(timeout); clearTimeout(escalation); signal?.removeEventListener("abort", abort) }
    child.once("error", (error) => { cleanup(); reject(error) })
    child.once("close", (status, killedBy) => {
      cleanup()
      const result = { status, signal: killedBy, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }
      if (failure) reject(failure)
      else resolve(result)
    })
  })
}
