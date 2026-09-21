/*
 * The repo-import seam: POST /api/github/import {owner, repo} starts the job;
 * GET /api/github/import/{jobId} polls it; POST /api/github/import/{jobId}/retry
 * re-runs a failed job (the route exists). Progress lives on one upserted
 * "repo-import" card (phase starting → running → done | failed). Lane sync
 * moved the routes behind the `/api/cloud/*` proxy like every other lane
 * seam and taught the card the job's own progress fields (stage, counts,
 * repository, workspace_id) plus the structured-429 rate-limit line — every
 * one parsed loose, rendered only when the wire carries it. Reference: multi
 * src/smithersCloud/githubImport.ts (startImport/pollImport) against plue
 * internal/routes/github_import.go.
 */
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import type { GitHubRefusal, SeamContext } from "./SeamContext"
import { createRunEpochs } from "./RunEpochs"
import { readGitHubRefusal } from "./SeamContext"
import { TOAST_SUPERSEDED } from "../controller/failures"
import { actorSharedState } from "../ActorBindings"

export interface RepoImportSeam {
  readonly importRepository: (repo?: string) => Promise<string | void>
  /** `repos.import.retry <jobId>`: re-run the failed job the card tracks. */
  readonly retryImport: (jobId: string) => Promise<string | void | { readonly value: string }>
  /** Reconnect persisted starting/running imports after a controller reload. */
  readonly resume: () => void
}

/**
 * Poll cadence knobs, module-level so tests can shorten the wait: one status
 * check every `delayMs`, at most `maxAttempts` checks, and `networkRetries`
 * consecutive dropped polls tolerated before the loop stops tracking. The
 * budget is thirty minutes at the production cadence: a large repository's
 * clone outlives two, and a card that gave up early sent the user into a
 * re-run and a 409 (review finding 7).
 */
export const repoImportPolling = {
  delayMs: 2_000,
  maxAttempts: 900,
  networkRetries: 2
}

/** The honest sign-off when polling can no longer see the job. */
export const REPO_IMPORT_LOST_STREAM_DETAIL = "lost the import stream — run /repos.import again to re-check"

type ImportPhase = "starting" | "running" | "done" | "failed"

interface ImportCount {
  readonly done: number
  readonly total: number
}

/** Plue's import job answer, reduced to what the card tracks. The wire shape
 *  is plue's ImportJob: {importJobId, status, stage?, counts?, error?,
 *  repository?, workspace_id?}. */
interface ImportJobAnswer {
  readonly jobId: string
  readonly status: "cloning" | "ready" | "failed"
  readonly stage: string | null
  readonly counts: { readonly refs: ImportCount; readonly objects: ImportCount; readonly issues: ImportCount } | null
  readonly error: string | null
  readonly repository: { readonly owner: string; readonly name: string } | null
  readonly workspaceId: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const parseCount = (value: unknown): ImportCount | null => {
  if (!isRecord(value)) return null
  const { done, total } = value
  if (typeof done !== "number" || !Number.isInteger(done) || done < 0) return null
  if (typeof total !== "number" || !Number.isInteger(total) || total < 0) return null
  return { done, total }
}

const parseImportJob = (body: unknown): ImportJobAnswer | null => {
  if (!isRecord(body)) return null
  const jobId = body.importJobId
  const status = body.status
  if (typeof jobId !== "string" || jobId === "") return null
  if (status !== "cloning" && status !== "ready" && status !== "failed") return null
  const counts = (() => {
    if (!isRecord(body.counts)) return null
    const refs = parseCount(body.counts.refs)
    const objects = parseCount(body.counts.objects)
    const issues = parseCount(body.counts.issues)
    return refs !== null && objects !== null && issues !== null ? { refs, objects, issues } : null
  })()
  const repository = (() => {
    if (!isRecord(body.repository)) return null
    const owner = body.repository.owner
    const name = body.repository.name
    return typeof owner === "string" && owner !== "" && typeof name === "string" && name !== ""
      ? { owner, name }
      : null
  })()
  return {
    jobId,
    status,
    stage: typeof body.stage === "string" && body.stage !== "" ? body.stage : null,
    counts,
    error: typeof body.error === "string" && body.error !== "" ? body.error : null,
    repository,
    workspaceId: typeof body.workspace_id === "string" && body.workspace_id !== "" ? body.workspace_id : null
  }
}

/** Human detail per in-flight stage — the reference's importStageDetail map. */
const STAGE_DETAIL: Readonly<Record<string, string>> = {
  resolving: "Contacting GitHub…",
  creating_repo: "Creating mirror…",
  cloning_github: "Downloading from GitHub…",
  pushing_mirror: "Uploading to Smithers Cloud…",
  importing_refs: "Importing branches…",
  creating_bookmark: "Preparing default branch…",
  provisioning_workspace: "Provisioning workspace…"
}

const stageDetail = (job: ImportJobAnswer): string | null =>
  job.status === "cloning" && job.stage !== null ? (STAGE_DETAIL[job.stage] ?? null) : null

const cardStatus = (phase: ImportPhase): "active" | "acted" | "error" =>
  phase === "done" ? "acted" : phase === "failed" ? "error" : "active"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The card fields one job answer carries; absent wire fields touch nothing. */
const jobProgress = (job: ImportJobAnswer): CardPatch => ({
  jobId: job.jobId,
  phase: "running",
  detail: null,
  ...(job.stage !== null ? { stage: job.stage } : {}),
  ...(job.counts !== null ? { counts: job.counts } : {}),
  ...(job.error !== null ? { error: job.error } : {}),
  ...(job.repository !== null ? { repository: job.repository } : {}),
  ...(job.workspaceId !== null ? { workspaceId: job.workspaceId } : {})
})

/** The card fields a poll or a refusal can touch; unset keys keep their last values. */
interface CardPatch {
  readonly jobId?: string | null
  readonly phase: ImportPhase
  readonly detail: string | null
  readonly stage?: string | null
  readonly counts?: NonNullable<ImportJobAnswer["counts"]>
  readonly error?: string | null
  readonly repository?: ImportJobAnswer["repository"]
  readonly workspaceId?: string | null
  readonly rateLimit?: GitHubRefusal["rateLimit"]
  readonly requestId?: string
  readonly requestKind?: "start" | "retry"
  readonly accountOwner?: string | null
}

export const createRepoImportSeam = (ctx: SeamContext): RepoImportSeam => {
  const cloud = (path: string): string => `${ctx.baseUrl}${CLOUD_ROUTE_PREFIX}api${path}`
  /*
   * One tracking loop per repo: a re-run (the card's "Try again", or the
   * command again) bumps the epoch so a superseded loop stops upserting a
   * card the new run now owns.
   */
  const epochs = createRunEpochs(ctx, "repoimport-epochs")
  const pending = actorSharedState(ctx, "repoimport-pending", () => new Map<string, Promise<unknown>>())
  const accountOwner = (): string | null => ctx.store.collections.identitySessions.get("identity")?.accountOwnerLogin ??
    ctx.store.collections.identitySessions.get("identity")?.login ?? null
  const pendingKey = (repo: string): string => `${accountOwner() ?? "anonymous"}:${repo}`
  const requestCurrent = (repo: string, requestId: string): boolean => {
    const card = ctx.store.collections.cards.get(`repo-import-${repo}`)
    return ctx.isDisposed?.() !== true && card?.kind === "repo-import" &&
      card.payload.requestId === requestId && card.payload.accountOwner === accountOwner()
  }

  const upsert = (repo: string, ordinal: number, createdAt: number, patch: CardPatch): void => {
    const id = `repo-import-${repo}`
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "repo-import" ? existing.payload : undefined
    const card: Card = {
      id,
      kind: "repo-import",
      title: `Import · ${repo}`,
      status: cardStatus(patch.phase),
      createdAt,
      // The creation-time ordinal, passed unchanged on every upsert so the
      // card never jumps around the transcript while the job progresses.
      ordinal,
      payload: {
        repo,
        jobId: patch.jobId !== undefined ? patch.jobId : prior?.jobId ?? null,
        phase: patch.phase,
        detail: patch.detail,
        ...(patch.stage !== undefined
          ? { stage: patch.stage }
          : prior?.stage !== undefined
          ? { stage: prior.stage }
          : {}),
        ...(patch.counts !== undefined
          ? { counts: patch.counts }
          : prior?.counts !== undefined
          ? { counts: prior.counts }
          : {}),
        ...(patch.error !== undefined
          ? { error: patch.error }
          : prior?.error !== undefined
          ? { error: prior.error }
          : {}),
        ...(patch.repository !== undefined
          ? { repository: patch.repository }
          : prior?.repository !== undefined
          ? { repository: prior.repository }
          : {}),
        ...(patch.workspaceId !== undefined
          ? { workspaceId: patch.workspaceId }
          : prior?.workspaceId !== undefined
          ? { workspaceId: prior.workspaceId }
          : {}),
        ...(patch.rateLimit !== undefined
          ? { rateLimit: patch.rateLimit }
          : prior?.rateLimit !== undefined
          ? { rateLimit: prior.rateLimit }
          : {}),
        ...(patch.requestId !== undefined ? { requestId: patch.requestId } : prior?.requestId !== undefined ? { requestId: prior.requestId } : {}),
        ...(patch.requestKind !== undefined ? { requestKind: patch.requestKind } : prior?.requestKind !== undefined ? { requestKind: prior.requestKind } : {}),
        ...(patch.accountOwner !== undefined ? { accountOwner: patch.accountOwner } : prior?.accountOwner !== undefined ? { accountOwner: prior.accountOwner } : {})
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  const track = async (
    repo: string,
    jobId: string,
    ordinal: number,
    createdAt: number,
    epoch: number,
    requestId: string
  ): Promise<string | void | typeof TOAST_SUPERSEDED> => {
    /*
     * The fence supersedes stale loops; a loop that has reached a terminal
     * hand-off retires its own live marker, guarded so a re-run's newer
     * epoch is never retired out from under it (a retired marker reads as
     * !== any stale epoch, which is the same stop signal the supersede check
     * already relies on). The epoch itself is never handed out twice, so a
     * loop parked in a poll across a re-run can never pass this fence.
     */
    const settleEpoch = (): void => epochs.settle(repo, epoch)
    let failures = 0
    for (let attempt = 0; attempt < repoImportPolling.maxAttempts; attempt += 1) {
      await sleep(repoImportPolling.delayMs)
      const card = ctx.store.collections.cards.get(`repo-import-${repo}`)
      if (ctx.isDisposed?.() === true || !epochs.isLive(repo, epoch) || card?.kind !== "repo-import" ||
        card.payload.requestId !== requestId || card.payload.accountOwner !== accountOwner()) return TOAST_SUPERSEDED
      let job: ImportJobAnswer | null = null
      let refusal: GitHubRefusal | null = null
      try {
        const response = await ctx.http(cloud(`/github/import/${encodeURIComponent(jobId)}`))
        if (response.ok) job = parseImportJob(await response.json().catch(() => undefined))
        else refusal = await readGitHubRefusal(response, `Reading the import job failed (HTTP ${response.status})`)
      } catch {
        // A dropped poll is retried below; the job keeps running upstream.
      }
      const currentCard = ctx.store.collections.cards.get(`repo-import-${repo}`)
      if (ctx.isDisposed?.() === true || !epochs.isLive(repo, epoch) || currentCard?.kind !== "repo-import" ||
        currentCard.payload.requestId !== requestId || currentCard.payload.accountOwner !== accountOwner()) return TOAST_SUPERSEDED
      if (refusal !== null) {
        /*
         * The server refused the read (a 401, a 500, a structured 429): its
         * words land on the card verbatim — with the rate-limit line when it
         * carried one — and Try again re-runs the job. Only a dropped
         * connection or an unreadable answer counts against the drop budget
         * (review finding 6: every non-OK poll used to read as a lost stream).
         */
        upsert(repo, ordinal, createdAt, {
          jobId,
          phase: "failed",
          detail: refusal.message,
          error: refusal.message,
          ...(refusal.rateLimit !== undefined ? { rateLimit: refusal.rateLimit } : {})
        })
        settleEpoch()
        return refusal.message
      }
      if (job === null) {
        failures += 1
        if (failures <= repoImportPolling.networkRetries) continue
        upsert(repo, ordinal, createdAt, { jobId, phase: "running", detail: REPO_IMPORT_LOST_STREAM_DETAIL })
        settleEpoch()
        return REPO_IMPORT_LOST_STREAM_DETAIL
      }
      failures = 0
      const progress = { ...jobProgress(job), jobId }
      if (job.status === "ready") {
        upsert(repo, ordinal, createdAt, { ...progress, phase: "done", detail: null })
        settleEpoch()
        return
      }
      if (job.status === "failed") {
        upsert(repo, ordinal, createdAt, {
          ...progress,
          phase: "failed",
          detail: job.error ?? "The import failed upstream."
        })
        settleEpoch()
        return job.error ?? "The import failed upstream."
      }
      upsert(repo, ordinal, createdAt, { ...progress, phase: "running", detail: stageDetail(job) ?? job.error })
    }
    // Attempts exhausted without a terminal status: same honest hand-off as a
    // lost stream — the command re-checks the job when run again.
    upsert(repo, ordinal, createdAt, { jobId, phase: "running", detail: REPO_IMPORT_LOST_STREAM_DETAIL })
    settleEpoch()
    return REPO_IMPORT_LOST_STREAM_DETAIL
  }

  /*
   * The shared start path: POST the start (or retry) route, then render and
   * track the job the answer names. `begin` upserts the starting card and
   * owns the epoch.
   */
  const startJob = async (
    repo: string,
    request: () => Promise<Response>,
    requestId: string,
    options: { readonly keepOrdinal?: { readonly ordinal: number; readonly createdAt: number } } = {}
  ): Promise<string | void | typeof TOAST_SUPERSEDED> => {
    if (!requestCurrent(repo, requestId)) return TOAST_SUPERSEDED
    const ordinal = options.keepOrdinal?.ordinal ?? ctx.nextOrdinal()
    const createdAt = options.keepOrdinal?.createdAt ?? Date.now()
    const epoch = epochs.start(repo)
    const current = (): boolean => {
      const card = ctx.store.collections.cards.get(`repo-import-${repo}`)
      return ctx.isDisposed?.() !== true && epochs.isLive(repo, epoch) && card?.kind === "repo-import" &&
        card.payload.requestId === requestId && card.payload.accountOwner === accountOwner()
    }
    /* The job this card already tracks — a 409 "already active" resumes it when the answer names none. */
    const tracked = ctx.store.collections.cards.get(`repo-import-${repo}`)
    const priorJobId = tracked?.kind === "repo-import" ? tracked.payload.jobId : null
    upsert(repo, ordinal, createdAt, { phase: "starting", detail: null, jobId: options.keepOrdinal === undefined ? null : undefined })
    /*
     * A start that ends without a tracking loop (every branch that returns
     * before `track` below) has a terminal epoch: settle it the same way
     * the loop's own terminal branches do, or one dead entry accumulates
     * per imported repo for the session.
     */
    const settleEpoch = (): void => epochs.settle(repo, epoch)

    let response: Response
    try {
      response = await request()
    } catch (error) {
      if (!current()) return TOAST_SUPERSEDED
      const reason = error instanceof Error ? error.message : String(error)
      const message = `The import couldn't start — ${reason}`
      upsert(repo, ordinal, createdAt, { phase: "failed", detail: message })
      settleEpoch()
      return message
    }
    if (!current()) return TOAST_SUPERSEDED
    if (response.status === 409) {
      /*
       * An active conflict is trackable only when either the answer or this
       * exact persisted attempt names a job. Every other 409 remains retryable.
       */
      const body: unknown = await response.json().catch(() => null)
      if (!current()) return TOAST_SUPERSEDED
      const record = isRecord(body) ? body : {}
      const message = str(record.message)?.slice(0, 240) ?? "The import was refused (HTTP 409)"
      const active = record.code === "github_import_already_active" || /already being imported/i.test(message)
      if (!active) {
        upsert(repo, ordinal, createdAt, { phase: "failed", detail: message, error: message })
        settleEpoch()
        return message
      }
      const activeJobId = str(record.importJobId) ?? str(record.import_job_id) ?? str(record.job_id) ?? priorJobId
      if (activeJobId === null) {
        upsert(repo, ordinal, createdAt, { phase: "failed", detail: message, error: message })
        settleEpoch()
        return message
      }
      upsert(repo, ordinal, createdAt, { jobId: activeJobId, phase: "running", detail: message })
      return track(repo, activeJobId, ordinal, createdAt, epoch, requestId)
    }
    if (!response.ok) {
      const refusal = await readGitHubRefusal(response, `The import couldn't start (HTTP ${response.status})`)
      if (!current()) return TOAST_SUPERSEDED
      upsert(repo, ordinal, createdAt, {
        phase: "failed",
        detail: refusal.message,
        error: refusal.message,
        ...(refusal.rateLimit !== undefined ? { rateLimit: refusal.rateLimit } : {})
      })
      settleEpoch()
      return refusal.message
    }
    const job = parseImportJob(await response.json().catch(() => undefined))
    if (!current()) return TOAST_SUPERSEDED
    if (job === null) {
      const message = "The import answer was malformed — the job id never arrived."
      upsert(repo, ordinal, createdAt, { phase: "failed", detail: message })
      settleEpoch()
      return message
    }
    const progress = jobProgress(job)
    if (job.status === "ready") {
      upsert(repo, ordinal, createdAt, { ...progress, phase: "done", detail: "already imported" })
      settleEpoch()
      return undefined
    }
    if (job.status === "failed") {
      const message = job.error ?? "The import failed upstream."
      upsert(repo, ordinal, createdAt, { ...progress, phase: "failed", detail: message })
      settleEpoch()
      return message
    }
    upsert(repo, ordinal, createdAt, { ...progress, phase: "running", detail: stageDetail(job) })
    // The toast lifetime includes this returned tracking promise.
    return track(repo, job.jobId, ordinal, createdAt, epoch, requestId)
  }

  const background = (
    repo: string,
    request: () => Promise<Response>,
    requestId: string,
    persisted: Promise<unknown>,
    options: { readonly keepOrdinal?: { readonly ordinal: number; readonly createdAt: number } } = {}
  ): Promise<unknown> => {
    const key = pendingKey(repo)
    const existing = pending.get(key)
    if (existing !== undefined) return existing
    const run = (ctx.withToast?.(
      `repos.import.${repo}`,
      `Importing ${repo}…`,
      `${repo} imported`,
      async () => {
        try { await persisted } catch {
          if (!requestCurrent(repo, requestId)) return TOAST_SUPERSEDED
          const message = "The import request couldn't be saved."
          upsert(repo, options.keepOrdinal?.ordinal ?? ctx.nextOrdinal(), options.keepOrdinal?.createdAt ?? Date.now(), { phase: "failed", detail: message, error: message })
          return message
        }
        if (!requestCurrent(repo, requestId)) return TOAST_SUPERSEDED
        return startJob(repo, request, requestId, options)
      }
    ) ?? (async () => {
      try { await persisted } catch {
        if (!requestCurrent(repo, requestId)) return TOAST_SUPERSEDED
        const message = "The import request couldn't be saved."
        upsert(repo, options.keepOrdinal?.ordinal ?? ctx.nextOrdinal(), options.keepOrdinal?.createdAt ?? Date.now(), { phase: "failed", detail: message, error: message })
        return message
      }
      if (!requestCurrent(repo, requestId)) return TOAST_SUPERSEDED
      return startJob(repo, request, requestId, options)
    })())
    pending.set(key, run)
    void run.finally(() => {
      if (pending.get(key) === run) pending.delete(key)
    })
    return run
  }

  const importRepository = async (explicit?: string): Promise<string | void> => {
    const resolved = resolveTargetRepo(ctx.store, explicit)
    if ("error" in resolved) return resolved.error
    const repo = resolved.repo
    const existing = ctx.store.collections.cards.get(`repo-import-${repo}`)
    const sameOwner = existing?.kind === "repo-import" &&
      (existing.payload.accountOwner === accountOwner() || existing.payload.accountOwner === undefined)
    if (sameOwner && existing?.kind === "repo-import" && (existing.payload.phase === "starting" ||
      (existing.payload.phase === "running" && existing.payload.detail !== REPO_IMPORT_LOST_STREAM_DETAIL))) {
      const key = pendingKey(repo)
      if (!pending.has(key)) {
        if (existing.payload.requestId === undefined || existing.payload.accountOwner === undefined) {
          const requestId = crypto.randomUUID()
          const persisted = ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: { ...existing,
            payload: { ...existing.payload, requestId, requestKind: existing.payload.requestKind ?? "start", accountOwner: accountOwner() } } }).isPersisted.promise
          void persisted.then(() => {
            if (!requestCurrent(repo, requestId)) return
            return importRepository(repo)
          }).catch(() => {
            if (!requestCurrent(repo, requestId)) return
            const message = "The import request couldn't be saved."
            upsert(repo, existing.ordinal, existing.createdAt, { phase: "failed", detail: message, error: message })
          })
          return
        }
        if (existing.payload.phase === "running" && existing.payload.jobId !== null) {
          const epoch = epochs.start(repo)
          const requestId = existing.payload.requestId ?? crypto.randomUUID()
          const run = (ctx.withToast?.(`repos.import.${repo}`, `Importing ${repo}…`, `${repo} imported`, () =>
            track(repo, existing.payload.jobId as string, existing.ordinal, existing.createdAt, epoch, requestId)) ??
            track(repo, existing.payload.jobId, existing.ordinal, existing.createdAt, epoch, requestId))
          pending.set(key, run)
          void run.finally(() => { if (pending.get(key) === run) pending.delete(key) })
        } else {
          const [owner, name] = repo.split("/") as [string, string]
          const requestId = existing.payload.requestId ?? crypto.randomUUID()
          const retryJobId = existing.payload.requestKind === "retry" ? existing.payload.jobId : null
          void background(repo, async () => {
            if (retryJobId !== null) {
              const observed = await ctx.http(cloud(`/github/import/${encodeURIComponent(retryJobId)}`))
              if (!observed.ok) return observed
              const copy = observed.clone()
              const job = parseImportJob(await copy.json().catch(() => undefined))
              if (job?.status !== "failed") return observed
              if (!requestCurrent(repo, requestId)) throw new Error("The import request was superseded.")
              return ctx.http(cloud(`/github/import/${encodeURIComponent(retryJobId)}/retry`), { method: "POST" })
            }
            return ctx.http(cloud("/github/import"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, repo: name }) })
          }, requestId, Promise.resolve(),
            { keepOrdinal: { ordinal: existing.ordinal, createdAt: existing.createdAt } })
        }
      }
      return
    }
    if (existing?.kind === "repo-import" && existing.payload.detail === REPO_IMPORT_LOST_STREAM_DETAIL) pending.delete(pendingKey(repo))
    const [owner, name] = repo.split("/") as [string, string]
    const ordinal = ctx.nextOrdinal()
    const createdAt = Date.now()
    const requestId = crypto.randomUUID()
    const identityOwner = accountOwner()
    const persisted = ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: {
      id: `repo-import-${repo}`, kind: "repo-import", title: `Import · ${repo}`, status: "active", createdAt, ordinal,
      payload: { repo, jobId: existing?.kind === "repo-import" && existing.payload.accountOwner === identityOwner
        ? existing.payload.jobId : null,
        phase: "starting", detail: null, requestId, requestKind: "start", accountOwner: identityOwner }
    } }).isPersisted.promise
    void background(repo, () =>
      ctx.http(cloud("/github/import"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, repo: name })
      }), requestId, persisted, { keepOrdinal: { ordinal, createdAt } })
    return
  }

  const retryImport: RepoImportSeam["retryImport"] = async (jobId) => {
    const trimmed = jobId.trim()
    if (trimmed === "") return "repos.import.retry needs a job id: /repos.import.retry <jobId>"
    /* The card that tracks this job owns the repo and the transcript slot. */
    const entry = [...ctx.store.collections.cards.values()].find(
      (card) => card.kind === "repo-import" && card.payload.jobId === trimmed
    )
    if (entry === undefined || entry.kind !== "repo-import") {
      return `No import card tracks job ${trimmed} — the retry button lives on the failed import's card.`
    }
    const repo = entry.payload.repo
    if (entry.payload.accountOwner !== undefined && entry.payload.accountOwner !== accountOwner()) {
      return "This import belongs to another account. Start a new import for the current account."
    }
    if (pending.has(pendingKey(repo)) || entry.payload.phase === "starting") {
      return { value: `Retrying the import of ${repo} — the card tracks it.` }
    }
    const requestId = crypto.randomUUID()
    const owner = accountOwner()
    const persisted = ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: {
      ...entry, status: "active", payload: { ...entry.payload, phase: "starting", detail: null, requestId, requestKind: "retry", accountOwner: owner }
    } }).isPersisted.promise
    void background(
      repo,
      () => ctx.http(cloud(`/github/import/${encodeURIComponent(trimmed)}/retry`), { method: "POST" }),
      requestId,
      persisted,
      { keepOrdinal: { ordinal: entry.ordinal, createdAt: entry.createdAt } }
    )
    return { value: `Retrying the import of ${repo} — the card tracks it.` }
  }

  const resume = (): void => {
    queueMicrotask(() => {
      for (const card of ctx.store.collections.cards.values()) {
        if (card.kind !== "repo-import" || (card.payload.phase !== "starting" && card.payload.phase !== "running")) continue
        const owner = accountOwner()
        if (card.payload.accountOwner === undefined || card.payload.accountOwner !== owner) continue
        void importRepository(card.payload.repo)
      }
    })
  }

  return { importRepository, retryImport, resume }
}
