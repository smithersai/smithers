/*
 * Lane L3 routes (LOCAL-APP.md "HTTP and WebSocket API"): repositories and
 * targets. Registered on the shared router from server.ts with one call.
 */
import type { NodeSidecar } from "../Node"
import type { Target } from "@smthrs/rpc/LocalApp"
import { REPO_FILES_PATH, RepoFilesRequestSchema, TARGET_PATTERN, TargetRunVerbSchema } from "@smthrs/rpc/LocalApp"
import type { RepositoryAccess } from "@smthrs/rpc/NativeRepository"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { readRepoPath } from "../RepoFiles"
import { createRepoStore } from "../Repos"
import type { RepoStore } from "../Repos"
import type { RepositoryAuthority } from "../RepositoryAuthority"
import { json, jsonError, readJson } from "../routes"
import type { LocalServer } from "../server"
import { createTargetRunner, queryTargets, TargetRunCapacityError, workspaceCwd } from "../Targets"
import type { TargetRunner } from "../Targets"
import { queryTargetGraph, revalidateTarget } from "../TargetGraph"
import { createTargetRunHistory } from "../TargetRunHistory"
import type { TargetRunHistory } from "../TargetRunHistory"

export interface RepoTargetRoutesOptions {
  readonly node: Promise<NodeSidecar | null>
  readonly authority: RepositoryAuthority
  /** Explicitly enabled only by the headless/dev host. Native mode is grant-only. */
  readonly allowManualRepositoryPaths?: boolean
  /**
   * Where opened repositories are remembered across launches
   * (`<stateDir>/repositories.json`). A grant is the user's act once: the
   * folder they picked reopens with the same access on the next launch, the
   * way every editor's recent folders do. Absent = nothing is remembered
   * (tests, one-shot hosts).
   */
  readonly stateDir?: string
  readonly cli?: string
  /** Stop repository PTYs on downgrade or close, including pending creates. */
  readonly onRepoAccessRevoked?: (repoId: string) => Promise<void>
  /** Runs when a repository closes, before the answer: the language-server host ends the repository's servers here. */
  readonly onRepoClosed?: (repoId: string) => Promise<void>
  readonly log?: (line: string) => void
}

export interface RepoTargetRoutes {
  /** Settles once the remembered repositories are reopened (or there were none). */
  readonly restored: Promise<void>
  readonly repos: RepoStore
  readonly runner: TargetRunner
  readonly history: TargetRunHistory
  readonly resolveRepo: (
    repoId: string,
    requiredAccess: RepositoryAccess
  ) => { readonly status: "ok"; readonly path: string } | { readonly status: "not-found" | "permission-denied" }
  /**
   * Closes run admission synchronously and settles once every running child
   * tree is reaped and its terminal history frames are flushed.
   */
  readonly stop: () => Promise<void>
}

interface TargetGrant {
  readonly id: string
  readonly label: string
  readonly workspace: string
  /** The snapshot's kinds: a legacy declaration workspace runs the target with the verb its first kind names. */
  readonly kinds: ReadonlyArray<string>
}

/*
 * A pattern run request: the verb is one of the CLI's, the pattern is an
 * exact label or a `//dir/...` subtree, and the workspace must be one the
 * repository detected. Nothing else reaches argv — the grammar IS the grant,
 * so no opaque id is minted for it.
 */
const PatternRunRequestSchema = z
  .object({
    repoId: z.string().min(1),
    workspace: z.string().min(1).optional(),
    verb: TargetRunVerbSchema,
    pattern: z.string().regex(TARGET_PATTERN)
  })
  .strict()

const RepoOpenRequestSchema = z.union([
  z.object({ authorizationId: z.string().min(1) }).strict(),
  z.object({ path: z.string().min(1) }).strict()
])

const stringField = (body: unknown, field: string): string | undefined => {
  if (typeof body !== "object" || body === null || !(field in body)) return undefined
  const value = (body as Record<string, unknown>)[field]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** The remembered grants file: every open repository's real path and access. */
const REMEMBERED_FILE = "repositories.json"
const RememberedSchema = z.object({
  repositories: z.array(z.object({ path: z.string().min(1), access: z.enum(["read", "read-write"]) }))
}).strict()

export const registerRepoTargetRoutes = (
  server: Pick<LocalServer, "router" | "publish" | "onMessage">,
  options: RepoTargetRoutesOptions
): RepoTargetRoutes => {
  const repos = createRepoStore()
  const rememberedPath = options.stateDir === undefined ? undefined : join(options.stateDir, REMEMBERED_FILE)
  /** Revocations must reach disk before success; ordinary opens may remain session-only. */
  const remember = async (repoAccess: ReadonlyMap<string, RepositoryAccess>, strict = false, closing?: string): Promise<void> => {
    if (rememberedPath === undefined) return
    const repositories = repos.list().filter((repo) => repo.id !== closing).map((repo) => ({ path: repo.path, access: repoAccess.get(repo.id) ?? "read" }))
    try {
      await mkdir(dirname(rememberedPath), { recursive: true })
      await writeFile(`${rememberedPath}.tmp`, JSON.stringify({ repositories }, null, 2))
      await rename(`${rememberedPath}.tmp`, rememberedPath)
    } catch (error) {
      if (strict) throw error
      options.log?.(`could not remember open repositories at ${rememberedPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const history = createTargetRunHistory({ log: options.log })
  const runner = createTargetRunner({
    publish: server.publish,
    onEvent: (run, event) => history.event(run, event),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
    ...(options.log === undefined ? {} : { log: options.log })
  })
  /*
   * A query mints an opaque grant per target. Runs accept only one of these
   * ids and resolve the label server-side; the browser never supplies an
   * unchecked command label to the process boundary. A grant's id stays
   * stable while its target (workspace + label) survives re-queries, so a
   * second client's query never invalidates the first client's cards; a grant
   * is retired only when the target disappears or authority closes (revoke).
   */
  const targetGrants = new Map<string, Map<string, TargetGrant>>()
  const repoAccess = new Map<string, RepositoryAccess>()
  const accessEpoch = new Map<string, number>()
  // Serialize grant changes and their disk snapshots so a concurrent open
  // cannot overwrite a completed revocation with an older remembered grant.
  let changing: Promise<unknown> = Promise.resolve()
  const change = (work: () => Promise<Response>): Promise<Response> => {
    const result = changing.then(work)
    changing = result.catch(() => {})
    return result
  }
  const revoke = async (repoId: string): Promise<void> => {
    accessEpoch.set(repoId, (accessEpoch.get(repoId) ?? 0) + 1)
    targetGrants.delete(repoId)
    await Promise.all([runner.revokeRepo(repoId), options.onRepoAccessRevoked?.(repoId)])
  }
  const { router } = server

  const resolveRepo: RepoTargetRoutes["resolveRepo"] = (repoId, requiredAccess) => {
    const repo = repos.get(repoId)
    if (repo === undefined) return { status: "not-found" }
    const access = repoAccess.get(repoId)
    if (access === undefined || (requiredAccess === "read-write" && access !== "read-write")) {
      return { status: "permission-denied" }
    }
    return { status: "ok", path: repo.path }
  }

  router.add("POST", "/api/repo/open", ({ request }) => change(async () => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const body = RepoOpenRequestSchema.safeParse(parsed.body)
    if (!body.success) {
      return jsonError(400, "invalid_request", "Body must contain exactly one repository authorization.")
    }
    let path: string
    let access: RepositoryAccess
    if ("authorizationId" in body.data) {
      const grant = options.authority.claim(body.data.authorizationId)
      if (grant === undefined) {
        return jsonError(403, "repository_authorization_invalid", "The repository authorization is invalid or expired. Choose the folder again.")
      }
      path = grant.path
      access = grant.access
    } else {
      if (options.allowManualRepositoryPaths !== true) {
        return jsonError(403, "manual_repository_paths_disabled", "Choose repositories through the native folder picker.")
      }
      path = body.data.path
      access = "read-write"
    }
    const result = await repos.open(path)
    if (result.status === "error") return jsonError(400, result.code, result.message)
    repoAccess.set(result.repo.id, access)
    if (access === "read") await revoke(result.repo.id)
    await remember(repoAccess)
    return json({ repo: result.repo })
  }))

  router.add("GET", "/api/repos", () => json({ repos: repos.list() }))

  /*
   * Reopen what the last launch had open. A path that is gone, or no longer
   * a repository, drops out silently: the next write forgets it. Ready is
   * awaited by the host before it serves, so the first GET /api/repos already
   * lists them and the sidebar's pins and the open set agree at boot.
   */
  const restored: Promise<void> = (async () => {
    if (rememberedPath === undefined) return
    let text: string
    try {
      text = await readFile(rememberedPath, "utf8")
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    const remembered = RememberedSchema.safeParse(parsed)
    if (!remembered.success) return
    let changed = false
    for (const entry of remembered.data.repositories) {
      const result = await repos.open(entry.path)
      if (result.status === "ok") repoAccess.set(result.repo.id, entry.access)
      else changed = true
    }
    if (changed) await remember(repoAccess)
  })()

  /*
   * Files in an open repository (LOCAL-APP.md "HTTP and WebSocket surface"):
   * read access suffices, the path is relative, and RepoFiles.ts keeps the
   * read inside the checkout. One route answers a directory or a file, so
   * the renderer's files seam renders the same cards it does for Cloud.
   */
  router.add("POST", REPO_FILES_PATH, async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const body = RepoFilesRequestSchema.safeParse(parsed.body)
    if (!body.success) return jsonError(400, "invalid_request", "Body must be { repoId, path? }.")
    const resolved = resolveRepo(body.data.repoId, "read")
    if (resolved.status !== "ok") {
      return resolved.status === "not-found"
        ? jsonError(404, "repo_not_found", `No open repository with id ${body.data.repoId}.`)
        : jsonError(403, "repository_read_denied", "This repository was not opened with read access.")
    }
    const answer = await readRepoPath(resolved.path, body.data.path ?? "")
    return answer.status === "ok" ? json(answer.body) : jsonError(answer.http, answer.code, answer.message)
  })

  router.add("POST", "/api/repo/access", ({ request }) => change(async () => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const body = z.object({ repoId: z.string().min(1), access: z.literal("read") }).strict().safeParse(parsed.body)
    if (!body.success) return jsonError(400, "invalid_request", "Body must be { repoId, access: 'read' }.")
    const { repoId } = body.data
    if (repos.get(repoId) === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    repoAccess.set(repoId, "read")
    await revoke(repoId)
    try {
      await remember(repoAccess, true)
    } catch {
      return jsonError(500, "repository_access_not_saved", "Read-only access could not be saved. Retry before quitting.")
    }
    return json({ ok: true })
  }))

  router.add("POST", "/api/repo/close", ({ request }) => change(async () => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    if (repoId === undefined) return jsonError(400, "invalid_request", "Body must be { repoId }.")
    if (repos.get(repoId) === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    repoAccess.delete(repoId)
    await revoke(repoId)
    await options.onRepoClosed?.(repoId)
    try {
      // Keep a denied row on failure so the renderer can resolve and retry it.
      await remember(repoAccess, true, repoId)
    } catch {
      return jsonError(500, "repository_access_not_saved", "The disconnection could not be saved. Retry before quitting.")
    }
    repos.close(repoId)
    return json({ ok: true })
  }))

  router.add("POST", "/api/targets/query", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    if (repoId === undefined) return jsonError(400, "invalid_request", "Body must be { repoId }.")
    const repo = repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    const result = await queryTargets({
      repo: repo.path,
      workspaces: repo.smithers.workspaces,
      node: await options.node,
      ...(options.cli === undefined ? {} : { cli: options.cli })
    })
    const previous = targetGrants.get(repoId)
    const surviving = new Map<string, TargetGrant>()
    for (const grant of previous?.values() ?? []) {
      surviving.set(`${grant.workspace}${grant.label}`, grant)
    }
    const grants = new Map<string, TargetGrant>()
    const targets: Array<Target> = result.targets.map((target) => {
      const kept = surviving.get(`${target.workspace}${target.label}`)
      const grant: TargetGrant = kept === undefined
        ? { id: crypto.randomUUID(), label: target.label, workspace: target.workspace, kinds: target.kinds }
        : { ...kept, kinds: target.kinds }
      grants.set(grant.id, grant)
      return { ...target, id: grant.id }
    })
    targetGrants.set(repoId, grants)
    return json({ ...result, targets })
  })

  router.add("POST", "/api/targets/run", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    const targetId = stringField(parsed.body, "targetId")
    const epoch = repoId === undefined ? undefined : accessEpoch.get(repoId)
    if (repoId !== undefined && targetId === undefined && stringField(parsed.body, "verb") !== undefined) {
      const pattern = PatternRunRequestSchema.safeParse(parsed.body)
      if (!pattern.success) {
        return jsonError(400, "invalid_request", "A pattern run is { repoId, verb, pattern, workspace? } with a CLI verb and a `//dir/...` pattern or label.")
      }
      const repo = repos.get(repoId)
      if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
      if (resolveRepo(repoId, "read-write").status !== "ok") {
        return jsonError(403, "repository_read_only", "Running a target requires read-write repository access.")
      }
      const workspace = pattern.data.workspace ?? "."
      if (!repo.smithers.workspaces.some((entry) => entry.path === workspace)) {
        return jsonError(409, "target_stale", "That target workspace is not open.")
      }
      const node = await options.node
      if (node === null) return jsonError(503, "node_missing", "No Node.js >= 22.19 was found for the smithers-build CLI.")
      if (resolveRepo(repoId, "read-write").status !== "ok" || accessEpoch.get(repoId) !== epoch) {
        return jsonError(403, "repository_read_only", "Repository access changed before execution.")
      }
      let run
      try {
        run = runner.reserve({
          repoId,
          repo: repo.path,
          workspace,
          label: `${pattern.data.verb} ${pattern.data.pattern}`,
          verb: pattern.data.verb,
          pattern: pattern.data.pattern,
          node
        })
      } catch (error) {
        if (error instanceof TargetRunCapacityError) return jsonError(429, error.code, error.message)
        throw error
      }
      try {
        await history.start(run)
      } catch (error) {
        await runner.cancel(run.runId)
        throw error
      }
      runner.arm(run.runId)
      return json({ runId: run.runId })
    }
    if (repoId === undefined || targetId === undefined) {
      return jsonError(400, "invalid_request", "Body must be { repoId, targetId } or { repoId, verb, pattern }.")
    }
    const repo = repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    if (resolveRepo(repoId, "read-write").status !== "ok") {
      return jsonError(403, "repository_read_only", "Running a target requires read-write repository access.")
    }
    const grant = targetGrants.get(repoId)?.get(targetId)
    if (grant === undefined) {
      return jsonError(404, "target_not_found", "That target is not in the current repository target snapshot.")
    }
    const workspace = grant.workspace
    if (!repo.smithers.workspaces.some((entry) => entry.path === workspace)) {
      targetGrants.get(repoId)?.delete(targetId)
      return jsonError(409, "target_stale", "That target workspace is no longer open.")
    }
    const node = await options.node
    if (node === null) return jsonError(503, "node_missing", "No Node.js >= 22.19 was found for the smithers-build CLI.")
    const graphOptions = {
      repoId,
      repo: workspaceCwd(repo.path, workspace),
      node,
      ...(options.cli === undefined ? {} : { cli: options.cli })
    }
    let graph: { readonly nodes: ReadonlyArray<{ readonly label: string }>; readonly edges: Awaited<ReturnType<typeof queryTargetGraph>>["edges"] }
    try {
      graph = await queryTargetGraph(graphOptions)
    } catch (error) {
      /*
       * The whole-repository graph is unavailable (one broken declaration
       * anywhere does that). The run only needs THIS target's closure, so
       * revalidate against `graph <label>`; only when that fails too is the
       * run refused, and the refusal then names the loader's reason.
       */
      const whole = error instanceof Error ? error.message : String(error)
      options.log?.(`target-run graph unavailable: ${whole}; revalidating ${grant.label} alone`)
      try {
        graph = await revalidateTarget(graphOptions, grant.label)
      } catch (scoped) {
        const reason = scoped instanceof Error ? scoped.message : String(scoped)
        options.log?.(`target-run ${grant.label} unavailable: ${reason}`)
        return jsonError(
          503,
          "target_graph_unavailable",
          `The target graph could not be revalidated before execution: ${reason}`
        )
      }
    }
    if (!graph.nodes.some((candidate) => candidate.label === grant.label)) {
      targetGrants.get(repoId)?.delete(targetId)
      return jsonError(409, "target_stale", "That target is no longer declared by the repository.")
    }
    if (resolveRepo(repoId, "read-write").status !== "ok" || accessEpoch.get(repoId) !== epoch) {
      return jsonError(403, "repository_read_only", "Repository access changed before execution.")
    }
    let run
    try {
      run = runner.reserve({
        repoId,
        repo: repo.path,
        workspace,
        label: grant.label,
        kinds: grant.kinds,
        node,
        edges: graph.edges
      })
    } catch (error) {
      if (error instanceof TargetRunCapacityError) {
        return jsonError(429, error.code, error.message)
      }
      throw error
    }
    try {
      await history.start(run)
    } catch (error) {
      await runner.cancel(run.runId)
      throw error
    }
    runner.arm(run.runId)
    return json({ runId: run.runId })
  })

  router.add("POST", "/api/targets/cancel", async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const runId = stringField(parsed.body, "runId")
    if (runId === undefined) return jsonError(400, "invalid_request", "Body must be { runId }.")
    if (runner.get(runId) === undefined) return jsonError(404, "run_not_found", `No target run with id ${runId}.`)
    const ok = await runner.cancel(runId)
    await history.flush()
    return json({ ok })
  })

  // A subscriber announces itself so the child starts once someone listens
  // (frames published before the subscription would be lost).
  const unregister = server.onMessage("target-run.attach", (message, socket) => {
    const runId = typeof message.runId === "string" ? message.runId : ""
    if (!runner.attach(runId)) {
      socket.send(JSON.stringify({ type: "error", message: `No target run with id ${runId}.` }))
    }
  })

  let stopPromise: Promise<void> | undefined
  return {
    restored,
    repos,
    runner,
    history,
    resolveRepo,
    stop: () => stopPromise ??= (async () => {
      unregister()
      const reaped = runner.stop()
      repoAccess.clear()
      try { await reaped } finally { await history.flush() }
    })()
  }
}
