/** Independent publication supervisor and a process-group launcher; no credentials reach disk. */
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { alive, atomicWrite, claimDecision, expiry, groupAlive, killPublisher, recordProbeFailure } from "./lock.mjs"

const send = (message) => { if (process.connected) process.send(message, () => {}) }
if (process.argv[2] === "runner") {
  // This process is the recorded process-group leader. No VCS executable can
  // start before its supervisor persists the group record and sends permission.
  let command, timeout
  const stop = () => { try { process.kill(-process.pid, "SIGKILL") } catch { process.exit(1) } }
  process.once("disconnect", stop)
  process.once("message", (request) => {
    const { directory, path, owner, deadline } = request
    if (!process.connected || !alive(owner.pid) || existsSync(join(directory, "done")) || !existsSync(join(path, `owner-${owner.token}`)) || expiry(directory, Date.now(), owner.staleMs, owner.maxHoldMs) || Date.now() >= deadline) return process.exit(1)
    timeout = setTimeout(stop, Math.max(1, deadline - Date.now()))
    command = spawn(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: ["ignore", "pipe", "pipe"] })
    command.stdout.on("data", (bytes) => send({ output: bytes.toString(), channel: "stdout" }))
    command.stderr.on("data", (bytes) => send({ output: bytes.toString(), channel: "stderr" }))
    command.once("error", () => { send({ result: { status: 1 } }); stop() })
    command.once("close", (status, signal) => {
      clearTimeout(timeout)
      // Kill any subprocess left behind even when the direct command exited.
      if (process.connected) process.send({ result: { status, signal } }, () => stop())
      else stop()
    })
  })
  send("ready")
} else {
  const directory = process.argv[2], path = process.argv[3]
  const owner = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"))
  let runner, record, result, disconnected = false, stopping, timeout
  const stop = () => {
    disconnected = true
    // The IPC endpoint is this launcher's own process reference. Let it stop
    // its group even when a concurrent ps probe cannot confirm its argv.
    if (runner?.connected) runner.disconnect()
    if (record) { try { killPublisher(record) } catch (error) { recordProbeFailure(directory, record, error) } }
    else if (runner) runner.kill("SIGKILL") // No execute permission exists yet.
  }
  process.once("disconnect", stop)
  process.once("message", (request) => {
    if (disconnected || !alive(owner.pid) || existsSync(join(directory, "done")) || Date.now() >= request.deadline) return process.exit(1)
    const token = randomUUID()
    runner = spawn(process.execPath, [fileURLToPath(import.meta.url), "runner", token], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] })
    timeout = setTimeout(stop, Math.max(1, request.deadline - Date.now()))
    runner.on("message", (message) => {
      if (message === "ready") {
        record = { host: hostname(), pid: runner.pid, token, supervisorPid: process.pid, deadline: request.deadline }
        atomicWrite(join(directory, "publisher.json"), JSON.stringify(record))
        // A parent death or revocation between launch and recording cannot cause
        // an unrecorded executable to run. The launcher repeats this check.
        if (disconnected || !alive(owner.pid) || existsSync(join(directory, "done")) || expiry(directory, Date.now(), owner.staleMs, owner.maxHoldMs) || !existsSync(join(path, `owner-${owner.token}`)) || !claimDecision(directory, "push")) return stop()
        runner.send({ ...request, directory, path, owner })
      } else if (message.result) result = message.result
      else send(message)
    })
    runner.once("error", () => { clearTimeout(timeout); process.exit(1) })
    runner.once("exit", () => {
      stopping ??= (async () => {
        clearTimeout(timeout)
        if (record) {
          killPublisher(record)
          while (groupAlive(record)) await delay(10)
        }
        atomicWrite(join(directory, "publisher-stopped"), JSON.stringify({ proof: "supervisor-group-exit", byPid: process.pid, time: Date.now() }))
        send({ result: result ?? { status: 1, signal: "interrupted" } })
        if (process.connected) process.disconnect()
      })().catch(() => process.exit(1))
    })
  })
  send("ready")
}
