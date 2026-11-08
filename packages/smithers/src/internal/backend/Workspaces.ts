/**
 * Workspace API operations, terminal sessions and durable remote execution.
 * @since 0.1.0
 */

import { WebSocket as NodeWebSocket } from "@effect/platform-node/NodeWS"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Refused, UsageError } from "../../CliError.vibe"
import * as Environment from "../../Environment.ts"
import * as Failure from "../Failure.ts"
import { type Client, esc, list, object, pick, positive, query, str, type Values, withCause } from "./Client.ts"
import type { Handler } from "./Resources.ts"
import { type Endpoint, hostKeys, remote } from "./SSH.ts"

const base = (c: Client, o: Values) => c.repoPath(o.repo) + "/workspaces"
const protocol = (message: string) => new Refused({ fault: "infra", code: "backend_protocol", message })
// A command whose outcome this invocation could not confirm: the operator
// reattaches by id, and the inner failure's own words are kept only as cause.
const reattach = (c: Client, error: unknown, requestID: string): Refused => {
  const known = c.failure(error), suffix = `; reattach with --exec-id ${requestID}`
  return withCause(
    known instanceof Refused
      ? new Refused({ fault: known.fault, code: known.code, message: `${known.message}${suffix}` })
      : new Refused({ fault: "infra", code: "exec_unconfirmed", message: `Lost contact with the command${suffix}` }),
    error
  )
}
/**
 * @private
 * @since 1.0.0
 */
export const resolveID = async (c: Client, a: Values, o: Values) => {
  if (a.id) return str(a.id)
  const workspaces = list(await c.request("GET", base(c, o))).map(object)
  const id = str(
    workspaces.find((ws) => ws.status === "running")?.id || workspaces[0]?.id ||
      object(await c.request("POST", base(c, o), { name: "" })).id
  )
  if (!id) throw protocol("Workspace response omitted id")
  return id
}
const sshInfo = async (c: Client, path: string, user: unknown): Promise<Endpoint> => {
  // Readiness is one attempt. A caller needing retries must use the durable
  // flow poller; this transport never hides a permanent request failure.
  const info = object(
    await c.request("GET", path + "/ssh" + query({ user: user && user !== "developer" ? user : undefined }))
  )
  if (info.ssh_command || info.command) {
    return { command: str(info.ssh_command || info.command), hostKeys: hostKeys(info.host_keys) }
  }
  throw new Refused({ fault: "infra", code: "workspace_not_ready", message: "Workspace is not SSH-ready" })
}
/**
 * @private
 * @since 1.0.0
 */
export const workspaceBody = (o: Values) => {
  const body: Values = { name: str(o.name), ...pick(o, ["kind"]) }
  if (o.snapshot) body.snapshot_id = o.snapshot
  if (o.ref) {
    if (o.snapshot) throw new UsageError({ message: "--ref cannot be combined with --snapshot" })
    body.source_ref = o.ref
  }
  const resources: Values = {}
  for (const [key, field] of [["cpus", "vcpu"], ["memory", "memory_mib"], ["disk", "disk_gib"]]) {
    if (o[key!] !== undefined) resources[field!] = positive(o[key!], key)
  }
  if (Object.keys(resources).length) body.resources = resources
  return body
}
/**
 * @private
 * @since 1.0.0
 */
export const workspaces: Record<string, Handler> = {}
workspaces["workspace create"] = async (c, _a, o) => {
  const created = await c.request("POST", base(c, o), workspaceBody(o))
  if (!o.wait) return created
  const id = str(object(created).id)
  if (!id) throw protocol("Workspace response omitted id")
  const deadline = Date.now() + Number(o.waitTimeout || 600) * 1000
  do {
    const ws = object(await c.request("GET", base(c, o) + `/${esc(id)}`))
    if (ws.status === "running") return ws
    if (["failed", "error"].includes(str(ws.status))) {
      throw new Refused({
        fault: "infra",
        code: "workspace_failed",
        message: Failure.terminalSafe(
          `${str(ws.failure_code) || "workspace_failed"}: ${
            str(ws.failure_message) || "Provisioning failed"
          }; workspace ${id} remains`
        )
      })
    }
    await delay(Environment.readMilliseconds(c.env, "SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS") ?? 3000, undefined, {
      signal: c.runtime.signal
    })
  } while (Date.now() < deadline)
  throw new Refused({ fault: "infra", code: "workspace_not_ready", message: `Workspace ${id} did not become running` })
}
workspaces["workspace list"] = (c, _a, o) => c.request("GET", base(c, o))
workspaces["workspace view"] = async (c, a, o) => {
  const path = base(c, o) + `/${esc(a.id)}`, ws = object(await c.request("GET", path))
  let ssh: unknown = null
  if (ws.status === "running") {
    try {
      ssh = await c.request("GET", path + "/ssh")
    } catch { /* detail may still be provisioning */ }
  }
  const started = Date.parse(str(ws.suspended_at && ws.updated_at ? ws.updated_at : ws.created_at)),
    minutes = Math.floor((Date.now() - started) / 60000)
  const info = object(ssh), host = info.host || info.ssh_host || ws.ssh_host
  const sshView = ssh || ws.ssh_host
    ? {
      command: info.command || info.ssh_command || (host ? `ssh ${str(host)}` : "SSH details available"),
      host: host || null,
      port: info.port || 22,
      username: info.username ?? null
    }
    : null
  return {
    ...ws,
    ssh: sshView,
    uptime: ws.status === "running" && Number.isFinite(started)
      ? minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
      : null,
    persistence: ws.persistence || "persistent",
    snapshot_id: ws.snapshot_id ?? null,
    idle_timeout_seconds: ws.idle_timeout_seconds ?? 1800
  }
}
workspaces["workspace delete"] = async (c, a, o) => {
  await c.confirm(o.yes, `delete workspace ${str(a.id)}`)
  await c.request("DELETE", base(c, o) + `/${esc(a.id)}`)
  return { status: "deleted", id: a.id }
}
workspaces["workspace fork"] = (c, a, o) => c.request("POST", base(c, o) + `/${esc(a.id)}/fork`, { name: str(o.name) })
workspaces["workspace snapshots"] = async (c, a, o) =>
  list(await c.pages((cursor) => c.repoPath(o.repo) + "/workspace-snapshots" + query({ limit: 100, cursor }), "", true))
    .filter((item) => object(item).workspace_id === a.id)
workspaces["workspace watch"] = async (c, a, o) => {
  const path = base(c, o) + `/${esc(a.id)}`
  const ws = object(await c.request("GET", path))
  return { ...ws, events: await c.events(path + "/stream", "done", ["deleted", "error"], "status") }
}
workspaces["workspace ssh"] = async (c, a, o) => {
  const id = await resolveID(c, a, o), ssh = await sshInfo(c, base(c, o) + `/${esc(id)}`, "")
  const result = await remote(c, ssh, undefined, 0, undefined, true)
  c.runtime.exit?.(result.code)
  return { connected: result.code === 0, workspace_id: id }
}
const interrupted = () =>
  new Refused({ fault: "user", code: "interrupted", message: "Command interrupted; execution ended" })
workspaces["workspace exec"] = async (c, a, o) => {
  const timeout = o.timeout === undefined ? 0 : Number(o.timeout)
  if (!str(o.command).trim() || !Number.isFinite(timeout) || timeout < 0) {
    throw new UsageError({ message: "A command and non-negative timeout are required" })
  }
  if (o.stdin || (o.user && o.user !== "developer")) {
    throw new UsageError({
      message: "Use workspace ssh or workspace shell for interactive input or another guest user"
    })
  }
  if (o.detach && timeout > 0) throw new UsageError({ message: "--detach cannot be combined with --timeout" })
  const entries = list(o.env).map(str)
  if (entries.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value))) {
    throw new UsageError({ message: "--env expects KEY=VALUE" })
  }
  const environment = Object.fromEntries(
    entries.map((value) => [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)])
  )
  const requestID = str(o["exec-id"]) || randomUUID()
  if (requestID.length > 128 || !requestID.trim()) throw new UsageError({ message: "Invalid exec id" })
  if (o.seedAgentAuth !== undefined) {
    throw new Refused({
      fault: "policy",
      code: "credential_seeding_disabled",
      message: "Credential seeding is disabled; workspace secrets require the secrets egress proxy"
    })
  }
  const id = await resolveID(c, a, o), path = base(c, o) + `/${esc(id)}/command-runs`
  let receipt: Values
  try {
    receipt = object(
      await c.request("POST", path, {
        operation_id: requestID,
        // A login shell's logout hooks can replace the command's exit status
        // under errexit, including after an EXIT trap has reported success.
        args: ["/bin/bash", "-c", str(o.command)],
        ...(o.cwd ? { directory: str(o.cwd) } : {}),
        environment
      })
    )
  } catch (error) {
    throw reattach(c, error, requestID)
  }
  if (typeof receipt.operationId !== "string" || !receipt.operationId) {
    throw protocol(`Command response omitted operationId; reattach with --exec-id ${requestID}`)
  }
  // A detached command keeps running under its durable receipt; the same
  // command with --exec-id reattaches to it.
  if (o.detach) {
    return { workspace_id: id, operation_id: receipt.operationId, exec_id: requestID, state: str(receipt.state) }
  }
  const runPath = `${path}/${esc(receipt.operationId)}`
  const deadline = timeout > 0 ? Date.now() + timeout * 1000 : Infinity
  const interval = Environment.readMilliseconds(c.env, "SMITHERS_WORKSPACE_COMMAND_POLL_INTERVAL_MS") ?? 1000
  let cancellationAttempted = false
  const cancel = async () => {
    cancellationAttempted = true
    const signal = AbortSignal.timeout(30_000)
    let run = object(await c.request("POST", runPath + "/cancel", undefined, { signal }))
    while (["accepted", "dispatching", "running", "waiting"].includes(str(run.state))) {
      if (run.operationId !== receipt.operationId) throw protocol("Mismatched command receipt")
      await delay(interval, undefined, { signal })
      run = object(await c.request("GET", runPath, undefined, { signal }))
    }
    if (run.operationId !== receipt.operationId || !["cancelled", "completed", "failed"].includes(str(run.state))) {
      throw new Refused({
        fault: "infra",
        code: "cancel_unconfirmed",
        message: "Command cancellation could not be confirmed"
      })
    }
  }
  try {
    for (;;) {
      if (c.runtime.signal?.aborted || Date.now() >= deadline) {
        await cancel()
        throw interrupted()
      }
      const signal = timeout > 0
        ? AbortSignal.any([
          AbortSignal.timeout(Math.max(1, Math.ceil(deadline - Date.now()))),
          ...(c.runtime.signal ? [c.runtime.signal] : [])
        ])
        : c.runtime.signal
      const run = object(await c.request("GET", runPath, undefined, signal ? { signal } : undefined))
      if (run.operationId !== receipt.operationId) throw protocol("Mismatched command receipt")
      if (run.state === "completed") {
        const result = object(run.result)
        if (
          !Number.isInteger(result.exit_code) || typeof result.stdout !== "string" ||
          typeof result.stderr !== "string" || typeof result.output_truncated !== "boolean"
        ) {
          throw protocol("Invalid command result")
        }
        c.output(Buffer.from(result.stdout), Buffer.from(result.stderr))
        c.flushOutput()
        c.runtime.exit?.(Number(result.exit_code))
        // A live run already streamed the child's output: the receipt omits it.
        const { stdout, stderr, ...receiptResult } = result
        return {
          workspace_id: id,
          operation_id: receipt.operationId,
          ...receiptResult,
          ...(c.live ? {} : { stdout, stderr })
        }
      }
      if (["failed", "uncertain", "cancelled"].includes(str(run.state))) {
        const state = str(run.state)
        throw new Refused({
          fault: state === "cancelled" ? "user" : "infra",
          code: `command_${state}`,
          message: Failure.terminalSafe(str(c.redact(str(run.error)))).trim() || `Command ${state}`
        })
      }
      if (!["accepted", "dispatching", "running", "waiting"].includes(str(run.state))) {
        throw protocol("Invalid command state")
      }
      // Check abort in the loop so cancellation uses its own live request signal.
      await delay(Math.min(interval, Math.max(1, deadline - Date.now())))
    }
  } catch (error) {
    if (
      !cancellationAttempted && (c.runtime.signal?.aborted || Date.now() >= deadline)
    ) {
      try {
        await cancel()
      } catch (cancelError) {
        throw reattach(c, cancelError, requestID)
      }
      throw interrupted()
    }
    throw reattach(c, error, requestID)
  }
}
const terminalSize = (flag: string, value: unknown): number => {
  const n = value === undefined ? 0 : typeof value === "string" && value.trim() === "" ? Number.NaN : Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new UsageError({ message: `--${flag} must be a whole number from 0 (detect) to 65535` })
  }
  return n
}
workspaces["workspace shell"] = async (c, a, o) => {
  const sizeCols = terminalSize("cols", o.cols), sizeRows = terminalSize("rows", o.rows)
  const id = await resolveID(c, a, o), path = c.repoPath(o.repo) + "/workspace/sessions"
  const cols = sizeCols || process.stdout.columns || 80, rows = sizeRows || process.stdout.rows || 24
  const session = object(await c.request("POST", path, { cols, rows, workspace_id: id }))
  if (!session.id) throw protocol("Terminal response omitted id")
  const auth = await c.session.require(),
    url = auth.api_url.replace(/^http/, "ws") + `${path}/${esc(session.id)}/terminal`
  const socket = new NodeWebSocket(url, { headers: { Authorization: `token ${auth.token}`, Origin: auth.api_url } })
  const raw = process.stdin.isRaw
  const input = (chunk: Buffer) => socket.send(chunk, { binary: true })
  const resize = () =>
    socket.send(
      JSON.stringify({ type: "resize", cols: process.stdout.columns || cols, rows: process.stdout.rows || rows })
    )
  let abort = () => socket.close()
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject)
      abort = () => {
        reject(interrupted())
        socket.close()
      }
      c.runtime.signal?.addEventListener("abort", abort, { once: true })
      if (c.runtime.signal?.aborted) {
        abort()
        return
      }
      socket.once("open", () => {
        if (c.runtime.signal?.aborted) {
          abort()
          return
        }
        if (process.stdin.isTTY) process.stdin.setRawMode(true)
        resize()
        process.stdin.on("data", input)
        process.stdout.on("resize", resize)
      })
      socket.on("message", (data, binary) => {
        if (!binary) {
          try {
            const message = object(JSON.parse(data.toString()))
            if (message.type === "status" && ["stopped", "failed"].includes(str(message.status))) {
              socket.close()
              if (message.status === "failed") c.runtime.exit?.(1)
              return
            }
          } catch { /* terminal text */ }
        }
        process.stdout.write(data.toString())
      })
      socket.once("close", () => resolve())
      process.stdin.once("end", abort)
    })
  } finally {
    process.stdin.off("data", input)
    process.stdin.off("end", abort)
    process.stdout.off("resize", resize)
    process.stdin.pause()
    if (process.stdin.isTTY) process.stdin.setRawMode(!!raw)
    c.runtime.signal?.removeEventListener("abort", abort)
    socket.close()
    await c.request("POST", `${path}/${esc(session.id)}/destroy`, undefined, { signal: AbortSignal.timeout(30_000) })
  }
}
workspaces["workspace issue"] = async () => {
  throw new Refused({
    fault: "policy",
    code: "durable_agent_required",
    message: "Workspace issue execution requires a durable agent flow"
  })
}
/**
 * @private
 * @since 1.0.0
 */
export const workspaceSSH = async (c: Client, id: string, options: Values) =>
  sshInfo(c, base(c, options) + `/${esc(id)}`, options.user)
