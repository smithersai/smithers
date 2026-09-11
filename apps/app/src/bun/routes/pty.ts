/*
 * The PTY routes and the `pty.input` frame (LOCAL-APP.md, "HTTP and
 * WebSocket API"): POST /api/pty opens a session, GET lists them, resize and
 * DELETE address one by id, and typed text arrives over `/ws` as
 * `{ type: "pty.input", sessionId, data }`. Output leaves through the
 * manager's publish on `pty:<sessionId>`.
 */
import { AgentRoleIdSchema } from "@smthrs/rpc/AgentRoles"
import { HARNESS_IDS } from "@smthrs/rpc/LocalApp"
import { z } from "zod"
import type { PtyManager } from "../Pty"
import { json, jsonError, readJson, Router } from "../routes"
import type { WsMessageHandler } from "../server"

export const PTY_PATH = "/api/pty"
export const PTY_INPUT_MAX_BYTES = 64 * 1024

const geometry = z.number().int().min(1).max(1000)

export const PtyCreateRequestSchema = z.object({
  kind: z.enum(["terminal", "harness"]),
  /** Omitted means home; repository paths are resolved from this opaque id. */
  repoId: z.string().min(1).optional(),
  cols: geometry,
  rows: geometry,
  harnessId: z.enum(HARNESS_IDS).optional(),
  /** A named role (AgentRoles.ts), built-in or custom, instead of a raw harness; the server picks the harness and composes the argv. */
  roleId: AgentRoleIdSchema.optional(),
  /** The delegated task, bounded: it becomes one CLI argument. */
  task: z.string().max(8_000).optional()
}).strict()

export const PtyResizeRequestSchema = z.object({ cols: geometry, rows: geometry })

export interface PtyRouteHost {
  readonly router: Router
  readonly onMessage: (type: string, handler: WsMessageHandler) => () => void
}

export interface PtyRepositoryResolver {
  readonly resolveRepo: (
    repoId: string
  ) => { readonly status: "ok"; readonly path: string } | { readonly status: "not-found" | "permission-denied" }
}

export const registerPtyRoutes = (
  host: PtyRouteHost,
  manager: PtyManager,
  repositories: PtyRepositoryResolver
): { readonly revokeRepo: (repoId: string) => Promise<void> } => {
  const { router } = host
  const sessionRepos = new Map<string, string>()
  const epochs = new Map<string, number>()
  const creating = new Map<string, Set<Promise<void>>>()

  router.add("GET", PTY_PATH, () => json({ sessions: manager.list() }))

  router.add("POST", PTY_PATH, async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const body = PtyCreateRequestSchema.safeParse(parsed.body)
    if (!body.success) {
      return jsonError(400, "invalid_request", "Body must be { kind, cols, rows } with optional repoId and harnessId.")
    }
    if (body.data.kind === "harness" && body.data.harnessId === undefined && body.data.roleId === undefined) {
      return jsonError(400, "invalid_request", "A harness session needs a harnessId or a roleId.")
    }
    const resolved = body.data.repoId === undefined
      ? ({ status: "ok", path: "~" } as const)
      : repositories.resolveRepo(body.data.repoId)
    if (resolved.status !== "ok") {
      return resolved.status === "not-found"
        ? jsonError(404, "repo_not_found", `No open repository with id ${body.data.repoId}.`)
        : jsonError(403, "repository_read_only", "A terminal requires read-write repository access.")
    }
    const repoId = body.data.repoId
    const epoch = repoId === undefined ? undefined : epochs.get(repoId)
    const done = Promise.withResolvers<void>()
    void done.promise.catch(() => {})
    if (repoId !== undefined) {
      const pending = creating.get(repoId) ?? new Set<Promise<void>>()
      pending.add(done.promise)
      creating.set(repoId, pending)
    }
    const result = await (async () => {
      try {
        const created = await manager.create({ ...body.data, cwd: resolved.path })
        if (created.status === "ok" && repoId !== undefined) {
          sessionRepos.set(created.session.sessionId, repoId)
          if (epochs.get(repoId) !== epoch || repositories.resolveRepo(repoId).status !== "ok") {
            try {
              await manager.kill(created.session.sessionId)
              sessionRepos.delete(created.session.sessionId)
            } catch (error) {
              done.reject(error)
              throw error
            }
            return undefined
          }
        }
        return created
      } finally {
        if (repoId !== undefined) {
          const pending = creating.get(repoId)
          pending?.delete(done.promise)
          if (pending?.size === 0) creating.delete(repoId)
        }
        done.resolve()
      }
    })()
    if (result === undefined) return jsonError(403, "repository_read_only", "Repository access changed while starting the terminal.")
    if (result.status === "error") {
      const status = result.code === "spawn_failed" ? 500
        : result.code === "manager_closed" ? 503
        : result.code === "unknown_harness" || result.code === "unknown_role" ? 404
        : result.code === "capacity_reached" ? 429
        : 400
      return jsonError(status, result.code, result.message)
    }
    return json({ sessionId: result.session.sessionId }, 201)
  })

  /*
   * The tab's recent output as text, for `tab.read` (the agent reading
   * another tab). `?tail=<bytes>` keeps only the end; the manager's own
   * scrollback bound applies before it.
   */
  router.add("GET", `${PTY_PATH}/:id/output`, ({ request, params }) => {
    const id = params.id ?? ""
    const tailParam = new URL(request.url).searchParams.get("tail")
    const tail = tailParam === null ? undefined : Number(tailParam)
    if (tail !== undefined && (!Number.isSafeInteger(tail) || tail < 0)) {
      return jsonError(400, "invalid_request", "tail must be a non-negative safe integer.")
    }
    const output = manager.read(id, tail)
    if (output === undefined) return jsonError(404, "not_found", `No PTY session ${id}.`)
    return json({ sessionId: id, ...output })
  })

  router.add("POST", `${PTY_PATH}/:id/resize`, async ({ request, params }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const body = PtyResizeRequestSchema.safeParse(parsed.body)
    if (!body.success) return jsonError(400, "invalid_request", "Body must be { cols, rows }.")
    const id = params.id ?? ""
    if (manager.get(id) === undefined) return jsonError(404, "not_found", `No PTY session ${id}.`)
    return json({ ok: manager.resize(id, body.data.cols, body.data.rows) })
  })

  router.add("DELETE", `${PTY_PATH}/:id`, async ({ params }) => {
    const id = params.id ?? ""
    const killed = await manager.kill(id)
    sessionRepos.delete(id)
    return killed ? json({ ok: true }) : jsonError(404, "not_found", `No PTY session ${id}.`)
  })

  host.onMessage("pty.input", (message, socket) => {
    const { sessionId, data } = message
    if (typeof sessionId !== "string" || typeof data !== "string") {
      socket.send(JSON.stringify({ type: "error", message: "pty.input needs a sessionId and data." }))
      return
    }
    if (new TextEncoder().encode(data).byteLength > PTY_INPUT_MAX_BYTES) {
      socket.send(JSON.stringify({ type: "error", message: `pty.input is capped at ${PTY_INPUT_MAX_BYTES} bytes.` }))
      return
    }
    const repoId = sessionRepos.get(sessionId)
    if (repoId !== undefined && repositories.resolveRepo(repoId).status !== "ok") {
      socket.send(JSON.stringify({ type: "error", message: "Repository access was revoked." }))
      return
    }
    if (!manager.write(sessionId, data)) {
      socket.send(JSON.stringify({ type: "error", message: `No live PTY session ${sessionId}.` }))
    }
  })
  return {
    revokeRepo: async (repoId) => {
      epochs.set(repoId, (epochs.get(repoId) ?? 0) + 1)
      const kills = [...sessionRepos].filter(([, id]) => id === repoId).map(async ([sessionId]) => {
        await manager.kill(sessionId)
        sessionRepos.delete(sessionId)
      })
      await Promise.all([...kills, ...(creating.get(repoId) ?? [])])
    }
  }

}
