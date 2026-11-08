/** Bounded child groups for bootstrap automation; cancellation waits for this invocation's children. */
import { spawn, spawnSync } from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"

const deadlines = new AsyncLocalStorage()
/** One bootstrap gate deadline, inherited by sync metadata reads and async farm clients. */
export const withProcessDeadline = (deadline, body) => deadlines.run(deadline, body)
export const boundedSpawnSync = (command, args, options = {}) => {
  const deadline = deadlines.getStore()
  if (!deadline) return spawnSync(command, args, options)
  const remaining = Math.floor(deadline.at - Date.now())
  if (remaining <= 0 || deadline.signal.aborted) throw deadline.signal.reason ?? deadline.expired()
  const result = spawnSync(command, args, { ...options, timeout: Math.min(options.timeout || remaining, remaining), killSignal: "SIGKILL" })
  if (Date.now() >= deadline.at || result.error?.code === "ETIMEDOUT") throw deadline.expired()
  return result
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, stream?: boolean, streamError?: boolean, onStart?: (pid: number | undefined) => void, onEnd?: (status: number | null, signal: NodeJS.Signals | null, failure?: unknown) => void}} [options]
 * @returns {Promise<{status: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string}>}
 */
export function runProcess(command, args, { cwd, env = process.env, signal, timeoutMs = 60000, maxBytes = 32 * 1024 * 1024, stream = false, streamError = false, onStart, onEnd } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = deadlines.getStore()
    if (deadline) {
      const remaining = Math.floor(deadline.at - Date.now())
      if (remaining <= 0) throw deadline.expired()
      timeoutMs = Math.min(timeoutMs, remaining)
      signal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
    }
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
    try { onStart?.(child.pid) } catch (error) { stop(error) }
    const abort = () => stop(signal.reason ?? new Error("Command interrupted"))
    const timeout = setTimeout(() => stop(deadline && Date.now() >= deadline.at ? deadline.expired() : new Error(`Command timed out after ${timeoutMs}ms: ${command}`)), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    const collect = (chunks, output, chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) stop(new Error(`Command output exceeded ${maxBytes} bytes: ${command}`))
      else chunks.push(chunk)
      if (stream) output.write(chunk)
    }
    child.stdout.on("data", (chunk) => collect(stdout, process.stdout, chunk))
    child.stderr.on("data", (chunk) => { collect(stderr, process.stderr, chunk); if (streamError && !stream) process.stderr.write(chunk) })
    const cleanup = () => { clearTimeout(timeout); clearTimeout(escalation); signal?.removeEventListener("abort", abort) }
    child.once("error", (error) => { cleanup(); reject(error) })
    child.once("close", (status, killedBy) => {
      cleanup()
      try { onEnd?.(status, killedBy, failure) } catch (error) { failure ??= error }
      const result = { status, signal: killedBy, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }
      if (failure) reject(failure)
      else resolve(result)
    })
  })
}
