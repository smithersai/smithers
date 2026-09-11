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

export interface RepoImportSeam {
  readonly importRepository: (repo?: string) => Promise<string | void>
  /** `repos.import.retry <jobId>`: re-run the failed job the card tracks. */
  readonly retryImport: (jobId: string) => Promise<string | void | { readonly value: string }>
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
}

export const createRepoImportSeam = (ctx: SeamContext): RepoImportSeam => {
  const cloud = (path: string): string => `${ctx.baseUrl}${CLOUD_ROUTE_PREFIX}api${path}`
  /*
   * One tracking loop per repo: a re-run (the card's "Try again", or the
   * command again) bumps the epoch so a superseded loop stops upserting a
   * card the new run now owns.
   */
  const epochs = createRunEpochs(ctx, "repoimport-epochs")

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
          : {})
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  const track = async (
    repo: string,
    jobId: string,
    ordinal: number,
    createdAt: number,
    epoch: number
  ): Promise<void> => {
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
      if (!epochs.isLive(repo, epoch)) return
      let job: ImportJobAnswer | null = null
      let refusal: GitHubRefusal | null = null
      try {
        const response = await ctx.http(cloud(`/github/import/${encodeURIComponent(jobId)}`))
        if (response.ok) job = parseImportJob(await response.json().catch(() => undefined))
        else refusal = await readGitHubRefusal(response, `Reading the import job failed (HTTP ${response.status})`)
      } catch {
        // A dropped poll is retried below; the job keeps running upstream.
      }
      if (!epochs.isLive(repo, epoch)) return
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
        return
      }
      if (job === null) {
        failures += 1
        if (failures <= repoImportPolling.networkRetries) continue
        upsert(repo, ordinal, createdAt, { jobId, phase: "running", detail: REPO_IMPORT_LOST_STREAM_DETAIL })
        settleEpoch()
        return
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
        return
      }
      upsert(repo, ordinal, createdAt, { ...progress, phase: "running", detail: stageDetail(job) ?? job.error })
    }
    // Attempts exhausted without a terminal status: same honest hand-off as a
    // lost stream — the command re-checks the job when run again.
    upsert(repo, ordinal, createdAt, { jobId, phase: "running", detail: REPO_IMPORT_LOST_STREAM_DETAIL })
    settleEpoch()
  }

  /*
   * The shared start path: POST the start (or retry) route, then render and
   * track the job the answer names. `begin` upserts the starting card and
   * owns the epoch.
   */
  const startJob = async (
    repo: string,
    request: () => Promise<Response>,
    options: { readonly keepOrdinal?: { readonly ordinal: number; readonly createdAt: number } } = {}
  ): Promise<string | void> => {
    const ordinal = options.keepOrdinal?.ordinal ?? ctx.nextOrdinal()
    const createdAt = options.keepOrdinal?.createdAt ?? Date.now()
    const epoch = epochs.start(repo)
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
      const reason = error instanceof Error ? error.message : String(error)
      const message = `The import couldn't start — ${reason}`
      upsert(repo, ordinal, createdAt, { phase: "failed", detail: message })
      settleEpoch()
      return message
    }
    if (response.status === 409) {
      /*
       * Plue's conflict verdicts are two different states, both read verbatim
       * (review finding 7): `github_import_already_active` — the job is on its
       * way, so the card keeps tracking it (the answer's job id, else the job
       * this card already tracks) — and "repository … already exists" — the
       * mirror is already there. Neither is a failure; only the second is done.
       */
      const body: unknown = await response.json().catch(() => null)
      const record = isRecord(body) ? body : {}
      const message = str(record.message)?.slice(0, 240) ?? "The import was refused (HTTP 409)"
      const active = record.code === "github_import_already_active" || /already being imported/i.test(message)
      if (!active) {
        upsert(repo, ordinal, createdAt, { phase: "done", detail: message })
        settleEpoch()
        return undefined
      }
      const activeJobId = str(record.importJobId) ?? str(record.import_job_id) ?? str(record.job_id) ?? priorJobId
      if (activeJobId === null) {
        upsert(repo, ordinal, createdAt, { phase: "running", detail: message })
        settleEpoch()
        return undefined
      }
      upsert(repo, ordinal, createdAt, { jobId: activeJobId, phase: "running", detail: message })
      void track(repo, activeJobId, ordinal, createdAt, epoch)
      return undefined
    }
    if (!response.ok) {
      const refusal = await readGitHubRefusal(response, `The import couldn't start (HTTP ${response.status})`)
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
    // Fire-and-forget: the job started and the card tracks it — success now.
    void track(repo, job.jobId, ordinal, createdAt, epoch)
    return undefined
  }

  const importRepository = async (explicit?: string): Promise<string | void> => {
    const resolved = resolveTargetRepo(ctx.store, explicit)
    if ("error" in resolved) return resolved.error
    const repo = resolved.repo
    const [owner, name] = repo.split("/") as [string, string]
    return startJob(repo, () =>
      ctx.http(cloud("/github/import"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, repo: name })
      })
    )
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
    const result = await startJob(
      repo,
      () => ctx.http(cloud(`/github/import/${encodeURIComponent(trimmed)}/retry`), { method: "POST" }),
      { keepOrdinal: { ordinal: entry.ordinal, createdAt: entry.createdAt } }
    )
    if (typeof result === "string") return result
    return { value: `Retrying the import of ${repo} — the card tracks it.` }
  }

  return { importRepository, retryImport }
}
