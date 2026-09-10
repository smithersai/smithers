/*
 * The GitHub seam (lane sync, ADR 0005; lane L5 against the live routes),
 * behind the `/api/cloud/*` proxy. Every path was read off plue's own router
 * (`cmd/server/router.go`):
 *
 *   GET  /api/repos/{owner}/{repo}/github-app-status  — the GitHub App install
 *        state, with the rate-limit facts when the wire carries them
 *        ({github_rate_limit_limit/remaining/reset}); renders the
 *        connector-setup card, never a transcript line.
 *   POST /api/repos/{owner}/{repo}/github/reconcile   — re-derive the App's
 *        wiring for ONE repository (plue#490). It is gated on repository
 *        write, not on the admin scope, so every writer may run it; the
 *        older global `/api/admin/github-app/reconcile` remains an operator
 *        route and no flow in this app calls it. The status re-read lands
 *        either way, and a refusal is plue's own sentence, verbatim. Its 202
 *        IS a mirror run (plue#502): `run_id` beside the same
 *        `{ id, state, refs[] }` the mirror-sync run answers, so the mirror
 *        card takes it and the same poll follows it. An answer that names no
 *        `run_id` is a server predating #502: the status re-read is then the
 *        whole act, exactly as before.
 *   POST /api/repos/{owner}/{repo}/github/mirror/refs/{ref}/retry — retry ONE
 *        failed ref (plue#491); the ref name is one URL-escaped segment and
 *        the answer is 202 { run_id }, a new run the card then tracks.
 *   GET  /api/repos/{owner}/{repo}                    — the repository DTO,
 *        read for three fields: `mirror_status` (synced | behind | failed |
 *        unconfigured) and plue#491's `behind_refs` / `failed_refs`, which
 *        turn the bare word into `behind GitHub · 3 refs`.
 *   POST /api/repos/{owner}/{repo}/mirror-sync        — start a mirror run
 *        (202 { run_id }).
 *   GET  /api/repos/{owner}/{repo}/mirror-sync/{run_id} — the run:
 *        { state, started_at, finished_at, refs[] { name, from, to, status,
 *        error } }. The refs ARE the card's rows.
 *
 * Rate limits (ADR "Rate limits"): a structured 429
 * `{code: "github_rate_limited", limit, remaining, reset_at}` becomes the
 * card's rate-limit line; a status answer whose remaining is under a fifth
 * of the limit shows the same line. Nothing is invented for a plain 429.
 *
 * No word on a card is this app's: a run's state and a ref's status are the
 * wire's own (`queued | running | succeeded | failed` for a run, `pending |
 * succeeded | failed` for a ref). A FAILED ref is retryable on its own since
 * plue#491; every other ref is not, because plue's route refuses it.
 */
import { CLOUD_ROUTE_PREFIX } from "@smthrs/rpc/LocalApp"
import type { Card, GitHubAppStatusInput } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { createRunEpochs } from "./RunEpochs"
import { readGitHubRefusal, trustedHttpsUrl } from "./SeamContext"
import type { GitHubRefusal, SeamContext } from "./SeamContext"

export const SIGN_OUT_REFUSAL = "Sign in to Smithers Cloud first — /cloud.sign-in."

/**
 * The mirror run poll: one read every `delayMs`, at most `maxAttempts`
 * (fifteen minutes at the production cadence), tolerating `networkRetries`
 * consecutive dropped reads before it stops tracking. Module-level so tests
 * shorten the wait.
 */
export const mirrorSyncPolling = {
  delayMs: 2_000,
  maxAttempts: 450,
  networkRetries: 2
}

/**
 * The honest sign-off when polling can no longer read the run: the header
 * keeps the last state it saw, because the run keeps going upstream.
 */
export const MIRROR_LOST_STREAM_TRIGGER = "lost the run stream — /github.sync re-reads it"

/** plue's `github_mirror_sync_runs.state` CHECK words that mean "no longer moving". */
const RUN_SETTLED = new Set(["succeeded", "failed"])

export interface GitHubSeam {
  /** `github.app [repo]`: read the App status and render the connector-setup card. */
  readonly app: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** Hidden, card-scoped: open the App's install page in the browser. */
  readonly openInstall: (repo?: string) => Promise<string | void>
  /** `github.reconcile [repo]`: re-derive the wiring, then re-read the status. */
  readonly reconcile: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** `github.mirror-sync [repo]`: start a mirror run and track its per-ref results. */
  readonly mirrorSync: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** `github.mirror.retry-ref <ref> [repo]`: retry ONE failed ref (plue#491). */
  readonly retryMirrorRef: (ref: string, repo?: string) => Promise<string | void | { readonly value: string }>
}

export interface GitHubSeamDeps {
  /** The native system-browser door; absent in a plain browser (window.open falls back). */
  readonly openExternal?: (url: string) => Promise<boolean>
}

type SyncPayload = Extract<Card, { kind: "sync-ops" }>["payload"]
type SyncOp = SyncPayload["ops"][number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Only the github.com https install origin is worth linking (multi githubInstallUrl.ts). */
export const trustedInstallUrl = (value: string): string | null => trustedHttpsUrl(value, "github.com")

interface StatusAnswer {
  readonly installed: boolean
  readonly configured: boolean
  readonly installationId: number | null
  readonly installUrl: string | null
  readonly rateLimit: { readonly limit: number; readonly remaining: number; readonly resetAt: string | null } | null
}

/** The github-app-status answer; the rate-limit facts ride along only when the wire names them. */
const parseStatus = (value: unknown): StatusAnswer | null => {
  if (!isRecord(value)) return null
  if (typeof value.github_app_installed !== "boolean" || typeof value.github_app_configured !== "boolean") return null
  const limit = intOrNull(value.github_rate_limit_limit)
  const remaining = intOrNull(value.github_rate_limit_remaining)
  return {
    installed: value.github_app_installed,
    configured: value.github_app_configured,
    installationId: intOrNull(value.installation_id),
    installUrl: str(value.install_url),
    rateLimit: limit !== null && remaining !== null
      ? { limit, remaining, resetAt: str(value.github_rate_limit_reset) }
      : null
  }
}

/** The line the ADR names when the rate limit is in view (a fifth of the budget left, or a 429). */
export const lowRateLimit = (rateLimit: { readonly limit: number; readonly remaining: number }): boolean =>
  rateLimit.limit > 0 && rateLimit.remaining * 5 < rateLimit.limit

/**
 * One `refs[]` entry of the mirror run, as the sync-ops card's row: plue's
 * `{ name, from, to, status, error }` becomes the ADR's `<from> → <to> ref
 * <name> push`, keeping the status word and the error text verbatim. Since
 * plue#491 a FAILED ref carries its own Retry (`POST …/github/mirror/refs/
 * {ref}/retry`); plue refuses the route for any other status, so no other
 * row offers one.
 */
export const parseMirrorRef = (value: unknown): SyncOp | null => {
  if (!isRecord(value)) return null
  const name = str(value.name)
  if (name === null) return null
  const error = str(value.error)
  return {
    id: name,
    source: str(value.from) ?? "—",
    target: str(value.to) ?? "—",
    entity: "ref",
    entityId: name,
    action: "push",
    status: str(value.status) ?? "",
    ...(error !== null ? { error } : {}),
    retryable: str(value.status) === "failed",
    at: null
  }
}

interface MirrorRunAnswer {
  readonly state: string
  readonly refs: ReadonlyArray<SyncOp>
}

const parseMirrorRun = (value: unknown): MirrorRunAnswer | null => {
  if (!isRecord(value)) return null
  const state = str(value.state)
  if (state === null) return null
  const refs = Array.isArray(value.refs)
    ? value.refs.flatMap((entry) => {
      const ref = parseMirrorRef(entry)
      return ref === null ? [] : [ref]
    })
    : []
  return { state, refs }
}

export const createGitHubSeam = (ctx: SeamContext, deps: GitHubSeamDeps = {}): GitHubSeam => {
  const cloud = (path: string): string => `${ctx.baseUrl}${CLOUD_ROUTE_PREFIX}api${path}`
  /* One tracking loop per repo: a re-run supersedes the loop before it. */
  const epochs = createRunEpochs(ctx, "github-epochs")

  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return SIGN_OUT_REFUSAL
  }

  const repoPath = (repo: string, suffix: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix === "" ? "" : `/${suffix}`}`
  }

  const readStatus = async (
    repo: string
  ): Promise<{ readonly status: StatusAnswer } | { readonly refusal: GitHubRefusal }> => {
    let response: Response
    try {
      response = await ctx.http(cloud(repoPath(repo, "github-app-status")))
    } catch (error) {
      return { refusal: { message: `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}` } }
    }
    if (!response.ok) {
      return { refusal: await readGitHubRefusal(response, `The GitHub App status for ${repo} couldn't be read (${response.status})`) }
    }
    const parsed = parseStatus(await response.json().catch(() => null))
    if (parsed === null) return { refusal: { message: `The GitHub App status answer for ${repo} was malformed.` } }
    return { status: parsed }
  }

  /**
   * The repository DTO, read for the three mirror facts it states:
   * `mirror_status` and — plue#491 — `behind_refs` / `failed_refs`. A refused
   * or malformed read answers null: the card then carries NO state word,
   * exactly as the ADR requires ("from the mirror status DTO once it
   * exists, else no state word at all"). A DTO that names the word but no
   * counts leaves the counts absent; `behind GitHub · n refs` needs a number
   * the server actually stated.
   */
  const readMirrorStatus = async (
    repo: string
  ): Promise<{ readonly status: string; readonly behindRefs: number | null; readonly failedRefs: number | null } | null> => {
    try {
      const response = await ctx.http(cloud(repoPath(repo, "")))
      if (!response.ok) return null
      const body: unknown = await response.json().catch(() => null)
      if (!isRecord(body)) return null
      const status = str(body.mirror_status)
      if (status === null) return null
      const behindRefs = intOrNull(body.behind_refs)
      const failedRefs = intOrNull(body.failed_refs)
      return {
        status,
        behindRefs: behindRefs === null || behindRefs < 0 ? null : behindRefs,
        failedRefs: failedRefs === null || failedRefs < 0 ? null : failedRefs
      }
    } catch {
      return null
    }
  }

  /** The mirror facts as the card's own patch; an unread DTO patches nothing. */
  const mirrorPatch = (
    read: { readonly status: string; readonly behindRefs: number | null; readonly failedRefs: number | null } | null
  ): Partial<SyncPayload> =>
    read === null ? {} : {
      mirrorStatus: read.status,
      ...(read.behindRefs === null ? {} : { behindRefs: read.behindRefs }),
      ...(read.failedRefs === null ? {} : { failedRefs: read.failedRefs })
    }

  /** The status row lands in the collection; the card renders from the same answer. */
  const dispatchStatus = (repo: string, status: StatusAnswer): void => {
    const row: GitHubAppStatusInput = {
      repo,
      installed: status.installed,
      configured: status.configured,
      installationId: status.installationId,
      installUrl: status.installUrl,
      rateLimit: status.rateLimit
    }
    ctx.dispatch({ type: "github.app-status.loaded", actor: "system", status: row })
  }

  const renderCard = (
    repo: string,
    answer: { readonly status: StatusAnswer } | { readonly refusal: GitHubRefusal },
    error?: GitHubRefusal
  ): void => {
    const id = `connector-setup-github-${repo}`
    const existing = ctx.store.collections.cards.get(id)
    const rateLimit = error?.rateLimit ?? ("status" in answer
      ? answer.status.rateLimit !== null && lowRateLimit(answer.status.rateLimit)
        ? answer.status.rateLimit
        : null
      : answer.refusal.rateLimit ?? null)
    const message = error?.message ?? ("status" in answer ? undefined : answer.refusal.message)
    const card: Card = {
      id,
      kind: "connector-setup",
      title: `GitHub · ${repo}`,
      status: message !== undefined
        ? "error"
        : "status" in answer && answer.status.installed && answer.status.configured
        ? "acted"
        : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload: {
        connector: "github",
        repo,
        phase: "status" in answer && answer.status.installed && answer.status.configured ? "connected" : "setup",
        steps: [],
        ...("status" in answer
          ? {
              installationId: answer.status.installationId,
              configured: answer.status.configured,
              ...(answer.status.installUrl !== null ? { installUrl: answer.status.installUrl } : {})
            }
          : {}),
        ...(message !== undefined ? { error: message } : {}),
        ...(rateLimit !== null ? { rateLimit } : {})
      }
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  const app: GitHubSeam["app"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const answer = await readStatus(target.repo)
    if ("status" in answer) dispatchStatus(target.repo, answer.status)
    renderCard(target.repo, answer)
    if ("refusal" in answer) return answer.refusal.message
    return {
      value: answer.status.installed && answer.status.configured
        ? `The Smithers GitHub App is installed on ${target.repo} — the card tracks it.`
        : `The Smithers GitHub App is not installed on ${target.repo} — the card has the install link.`
    }
  }

  const openInstall: GitHubSeam["openInstall"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    const row = ctx.store.collections.githubAppStatuses.get(target.repo)
    const card = ctx.store.collections.cards.get(`connector-setup-github-${target.repo}`)
    const installUrl = (card?.kind === "connector-setup" ? card.payload.installUrl : undefined) ?? row?.installUrl ?? null
    const trusted = installUrl !== null ? trustedInstallUrl(installUrl) : null
    if (trusted === null) return `No install link for ${target.repo} yet — /github.app reads the status first.`
    if (deps.openExternal !== undefined) void deps.openExternal(trusted)
    else if (typeof window !== "undefined") window.open(trusted, "_blank", "noopener")
    return undefined
  }

  const reconcile: GitHubSeam["reconcile"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    let response: Response
    try {
      response = await ctx.http(cloud(repoPath(target.repo, "github/reconcile")), { method: "POST" })
    } catch (error) {
      return `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}`
    }
    if (!response.ok) {
      /* plue gates this on repository write (plue#490): a refusal is its own sentence, verbatim. */
      const refusal2 = await readGitHubRefusal(response, `The reconcile failed (${response.status})`)
      const answer = await readStatus(target.repo)
      if ("status" in answer) dispatchStatus(target.repo, answer.status)
      renderCard(target.repo, answer, refusal2)
      return refusal2.message
    }
    const body = await response.json().catch(() => null)
    const runId = isRecord(body) ? intOrNull(body.run_id) : null
    const answer = await readStatus(target.repo)
    if ("status" in answer) dispatchStatus(target.repo, answer.status)
    renderCard(target.repo, answer)
    /*
     * The run plue started is tracked whatever the status re-read did: a
     * refused GET on a different route is not a reason to drop the run the
     * platform already named.
     */
    const id = runId === null ? null : String(runId)
    if (id !== null) {
      beginRun(target.repo, id, body, mirrorPatch(await readMirrorStatus(target.repo)), `reconcile started · run ${id}`)
    }
    if ("refusal" in answer) return answer.refusal.message
    /* A server that names no run id reconciled all the same; nothing more is claimed for it. */
    if (id === null) return { value: `Reconciled — the GitHub card for ${target.repo} re-read the App status.` }
    return {
      value: `Reconciled — the GitHub card for ${target.repo} re-read the App status; mirror run ${id} tracks the refs.`
    }
  }

  /* ---- the mirror run ---- */

  const mirrorCardIdOf = (repo: string): string => `sync-ops-mirror-${repo}`

  const upsertMirrorCard = (repo: string, patch: Partial<SyncPayload>): void => {
    const id = mirrorCardIdOf(repo)
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "sync-ops" ? existing.payload : undefined
    const payload: SyncPayload = {
      subject: `GitHub → ${repo} mirror`,
      source: "github-mirror",
      repo,
      runState: patch.runState !== undefined ? patch.runState : prior?.runState ?? null,
      ops: (patch.ops ?? prior?.ops ?? []).map((op) => ({ ...op })),
      ...(patch.runId !== undefined ? { runId: patch.runId } : prior?.runId !== undefined ? { runId: prior.runId } : {}),
      ...(patch.mirrorStatus !== undefined
        ? { mirrorStatus: patch.mirrorStatus }
        : prior?.mirrorStatus !== undefined
        ? { mirrorStatus: prior.mirrorStatus }
        : {}),
      ...(patch.behindRefs !== undefined
        ? { behindRefs: patch.behindRefs }
        : prior?.behindRefs !== undefined
        ? { behindRefs: prior.behindRefs }
        : {}),
      ...(patch.failedRefs !== undefined
        ? { failedRefs: patch.failedRefs }
        : prior?.failedRefs !== undefined
        ? { failedRefs: prior.failedRefs }
        : {}),
      ...(patch.trigger !== undefined ? { trigger: patch.trigger } : prior?.trigger !== undefined ? { trigger: prior.trigger } : {}),
      ...(patch.rateLimit !== undefined ? { rateLimit: patch.rateLimit } : prior?.rateLimit !== undefined ? { rateLimit: prior.rateLimit } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {})
    }
    const card: Card = {
      id,
      kind: "sync-ops",
      title: `Mirror sync · GitHub → ${repo}`,
      status: payload.error !== undefined ? "error" : payload.runState === "succeeded" ? "acted" : "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card })
  }

  /*
   * The run poll: `{ state, refs[] }` in, the header word and the card's
   * rows out, until the run settles (`succeeded`/`failed`), a newer run
   * supersedes it, or the budget runs out.
   */
  const trackMirrorRun = async (repo: string, runId: string, epoch: number): Promise<void> => {
    const settle = (): void => epochs.settle(repo, epoch)
    let drops = 0
    for (let attempt = 0; attempt < mirrorSyncPolling.maxAttempts; attempt += 1) {
      await wait(mirrorSyncPolling.delayMs)
      if (!epochs.isLive(repo, epoch)) return
      let response: Response
      try {
        response = await ctx.http(cloud(`${repoPath(repo, "mirror-sync")}/${encodeURIComponent(runId)}`))
      } catch {
        /*
         * A dropped poll is retried; plue's run keeps pushing refs for up to
         * fifteen minutes, so one lost connection is not a failed run and
         * never reads as one (review finding 3). Only a refusal below is
         * terminal.
         */
        if (!epochs.isLive(repo, epoch)) return
        drops += 1
        if (drops <= mirrorSyncPolling.networkRetries) continue
        upsertMirrorCard(repo, { trigger: MIRROR_LOST_STREAM_TRIGGER })
        settle()
        return
      }
      drops = 0
      if (!epochs.isLive(repo, epoch)) return
      if (!response.ok) {
        const refusal = await readGitHubRefusal(response, `Reading the mirror run failed (${response.status})`)
        upsertMirrorCard(repo, {
          error: refusal.message,
          ...(refusal.rateLimit !== undefined ? { rateLimit: refusal.rateLimit } : {})
        })
        settle()
        return
      }
      const run = parseMirrorRun(await response.json().catch(() => null))
      if (run === null) {
        upsertMirrorCard(repo, { error: `The mirror run answer for ${repo} was malformed.` })
        settle()
        return
      }
      upsertMirrorCard(repo, { runState: run.state, ops: [...run.refs] })
      if (RUN_SETTLED.has(run.state)) {
        /* The run moved the mirror: re-read the repository's own words and counts for it. */
        const mirror = await readMirrorStatus(repo)
        if (mirror !== null && epochs.isLive(repo, epoch)) upsertMirrorCard(repo, mirrorPatch(mirror))
        settle()
        return
      }
    }
    settle()
  }

  /*
   * A named run lands on the mirror card and the poll takes it from there.
   * The answer may already BE the run (plue#502's reconcile carries the whole
   * `{ id, state, refs[] }`) or name only its id (the mirror-sync trigger's
   * `{ run_id }`); the card states whatever the answer stated, and the poll
   * fills the rest.
   */
  const beginRun = (repo: string, runId: string, body: unknown, mirror: Partial<SyncPayload>, trigger: string): void => {
    const run = parseMirrorRun(body)
    upsertMirrorCard(repo, {
      runId,
      runState: run?.state ?? null,
      ops: run === null ? [] : [...run.refs],
      trigger,
      error: undefined,
      ...mirror
    })
    void trackMirrorRun(repo, runId, epochs.start(repo))
  }

  const mirrorSync: GitHubSeam["mirrorSync"] = async (explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    return startMirrorRun(target.repo, repoPath(target.repo, "mirror-sync"), {
      failed: "The mirror sync failed",
      started: (id) => `sync started · run ${id}`,
      value: (id, repo) => `Mirror run ${id} started for ${repo} — the card tracks its refs.`,
      unnamed: (repo) => `Smithers Cloud started the mirror sync for ${repo} without naming a run id.`
    })
  }

  /*
   * One mirror run, started at `path` and tracked on the repository's card.
   * The whole-mirror sync and plue#491's per-ref retry answer the SAME
   * 202 `{ run_id }` and are tracked by the same poll, so they share this.
   */
  const startMirrorRun = async (
    repo: string,
    path: string,
    words: {
      readonly failed: string
      readonly started: (runId: string) => string
      readonly value: (runId: string, repo: string) => string
      readonly unnamed: (repo: string) => string
    }
  ): Promise<string | { readonly value: string }> => {
    /* The repository's own mirror facts, before the run says anything. */
    const mirror = mirrorPatch(await readMirrorStatus(repo))
    let response: Response
    try {
      response = await ctx.http(cloud(path), { method: "POST" })
    } catch (error) {
      const message = `Could not reach Smithers Cloud: ${error instanceof Error ? error.message : String(error)}`
      upsertMirrorCard(repo, { error: message, ...mirror })
      return message
    }
    if (!response.ok) {
      const refusal = await readGitHubRefusal(response, `${words.failed} (${response.status})`)
      upsertMirrorCard(repo, {
        error: refusal.message,
        ...mirror,
        ...(refusal.rateLimit !== undefined ? { rateLimit: refusal.rateLimit } : {})
      })
      return refusal.message
    }
    const body = await response.json().catch(() => null)
    const runId = isRecord(body) ? intOrNull(body.run_id) : null
    if (runId === null) {
      const message = words.unnamed(repo)
      upsertMirrorCard(repo, { error: message, ...mirror })
      return message
    }
    const id = String(runId)
    beginRun(repo, id, body, mirror, words.started(id))
    return { value: words.value(id, repo) }
  }

  /*
   * plue#491 `POST …/github/mirror/refs/{ref}/retry` (202 { run_id }). Ref
   * names carry slashes and arrive as ONE escaped segment, so the name is
   * encoded whole — `refs/heads/main` is one parameter, never three.
   */
  const retryMirrorRef: GitHubSeam["retryMirrorRef"] = async (ref, explicit) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const name = ref.trim()
    if (name === "") return "github.mirror.retry-ref needs a ref: /github.mirror.retry-ref <ref> [owner/repo]"
    const target = resolveTargetRepo(ctx.store, explicit)
    if ("error" in target) return target.error
    return startMirrorRun(target.repo, repoPath(target.repo, `github/mirror/refs/${encodeURIComponent(name)}/retry`), {
      failed: `The retry of ${name} failed`,
      started: (id) => `${name} retried · run ${id}`,
      value: (id, repo) => `${name} is being pushed again on ${repo} — run ${id}; the card tracks it.`,
      unnamed: (repo) => `Smithers Cloud retried ${name} on ${repo} without naming a run id.`
    })
  }

  return { app, openInstall, reconcile, mirrorSync, retryMirrorRef }
}
