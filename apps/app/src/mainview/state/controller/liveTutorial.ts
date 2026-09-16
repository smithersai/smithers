import { LIVE_TUTORIAL_API,LiveTutorialRunSchema,type LiveTutorialOperation,type LiveTutorialRun,type LiveTutorialStart } from "@smthrs/rpc/LiveTutorial"
import type { Card } from "../AppState"
import { conversationTabIdOf } from "../AppState"
import { LiveTutorialLimitSchema,activeLiveTutorialLimit,liveTutorialLimitMessage,type LiveTutorialLimit } from "../LiveTutorialLimit"
import { PRACTICE_CARD,PRACTICE_REPO } from "../practice/PracticeRepository"
import { PRACTICE_DIFF_CARD } from "../seams/DiffFilesSeam"
import type { ControllerContext } from "./context"
import { TOAST_SUPERSEDED } from "./failures"

class TutorialLimitError extends Error {
  constructor(readonly limit: LiveTutorialLimit) { super(liveTutorialLimitMessage(limit)) }
}

type RunCard = Extract<Card, { kind: "run-trace" }>
type Request = LiveTutorialStart & { operation: LiveTutorialOperation; conversation?: string }
const idFor = (operation: LiveTutorialOperation) => operation === "plan" ? PRACTICE_CARD.plan : operation === "implement" ? PRACTICE_CARD.run : `live-tutorial-${operation}`
const requestOf = (card: RunCard | undefined): Request | undefined => card?.payload.input?.liveTutorial as Request | undefined
export const liveSnapshotOf = (card: Card | undefined): LiveTutorialRun | undefined => {
  if (card?.kind !== "run-trace") return
  const parsed = LiveTutorialRunSchema.safeParse(card.payload.input?.liveTutorialSnapshot)
  return parsed.success ? parsed.data : undefined
}

/** Anonymous tutorial runs use the same durable card/flow dispatcher as connected repositories. */
export function createLiveTutorialController(ctx: ControllerContext, nextOrdinal: () => number) {
  let disposed = false
  const pending = new Map<string, Promise<unknown>>()
  const sleepers = new Map<ReturnType<typeof setTimeout>, () => void>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  ctx.onDispose(() => {
    disposed = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const [timer, wake] of sleepers) { clearTimeout(timer); wake() }
    sleepers.clear()
  })
  const readCard = (id: string): RunCard | undefined => { const card = ctx.store.collections.cards.get(id); return card?.kind === "run-trace" ? card : undefined }
  const current = (id: string, request: Request) => !disposed && requestOf(readCard(id))?.idempotencyKey === request.idempotencyKey && (0) === request.playthrough

  const upsert = (card: Card) => ctx.store.dispatch({ type: "card.upsert", actor: "system", card }).isPersisted.promise
  const publish = async (id: string, request: Request, run: LiveTutorialRun, reconcile = false) => {
    if (!current(id, request)) return
    const card = readCard(id)!
    if (reconcile && card.payload.input?.liveTutorialAppliedRun === run.runId) return
    // Frame history proves the Change was applied even if navigation happened
    // before the final run receipt reached disk. Preserve the user's Back.
    if (reconcile && run.operation === "change" && run.change && ctx.store.collections.cards.get(PRACTICE_CARD.commits)?.kind === "commit-pick" &&
        ctx.store.collections.cardHistories.get(PRACTICE_CARD.commits)?.entries.some(entry => entry.kind === "change" && entry.payload.changeId === run.change!.id)) return
    await upsert({ ...card, title: run.plan?.title ?? card.title, status: run.phase === "failed" ? "error" : card.status === "acted" ? "acted" : "active",
      payload: { ...card.payload, runId: run.runId, phase: run.phase === "queued" ? "launching" : run.phase,
        result: run.result ?? null, error: run.error, observationError: undefined,
        steps: run.events.map(event => event.label), lastSeq: run.events.length,
        input: { ...card.payload.input, liveTutorialLimit: undefined, liveTutorialSnapshot: run, ...(run.plan ? { liveTutorialPlan: run.plan } : {}) } } })
    if (run.phase !== "completed") return
    if (run.operation === "research" || run.operation === "poc") {
      const catalog = ctx.store.collections.cards.get("practice-issue-flows-3")
      if (catalog?.kind === "workflow-list") await upsert({ ...catalog, payload: { ...catalog.payload, research: run.result ?? "" } })
    }
    if (run.operation === "implement") {
      if (!run.commits?.length || !run.diff || !run.files || run.tests?.exitCode !== 0) throw Error("The live run did not return verified commits, files and passing tests.")
      const previous = ctx.store.collections.cards.get(PRACTICE_CARD.commits)
      if (!previous || (previous.kind === "commit-pick" && JSON.stringify(previous.payload.rows.map(row => row.commitId)) !== JSON.stringify(run.commits.map(commit => commit.commitId)))) await upsert({ id: PRACTICE_CARD.commits, kind: "commit-pick", title: `Commits on ${run.branch ?? "tutorial"}`, status: "active", createdAt: previous?.createdAt ?? Date.now(), ordinal: previous?.ordinal ?? nextOrdinal(),
        payload: { repo: PRACTICE_REPO, branch: run.branch ?? "tutorial", targetBookmark: "main",
          rows: run.commits.map((commit, index) => ({ index: index + 1, commitId: commit.commitId, changeId: commit.commitId, message: commit.message,
            additions: commit.additions, deletions: commit.deletions, locked: run.commits!.length === 1 })), picked: run.commits.map((_, index) => index + 1) } })
    }
    if (run.operation === "change" && run.change) {
      const previous = ctx.store.collections.cards.get(PRACTICE_CARD.commits)
      const implementation = liveSnapshotOf(readCard(PRACTICE_CARD.run))
      const commits = (implementation?.commits ?? []).filter(commit => run.change!.commitIds.includes(commit.commitId))
      const top = commits.at(-1)
      if (!top) throw Error("The live Change has no matching implementation commits.")
      if (previous?.kind !== "change" || previous.payload.changeId !== run.change.id) await ctx.store.dispatch({ type: "card.navigated", actor: "system", card: { id: PRACTICE_CARD.commits, kind: "change", title: run.change.title, status: "active", createdAt: previous?.createdAt ?? Date.now(), ordinal: previous?.ordinal ?? nextOrdinal(),
        payload: { repo: PRACTICE_REPO, changeId: run.change.id, description: run.change.summary, commitId: top.commitId,
          currentSeq: null, revisionCount: null, revisions: [], authorName: "Smithers", timestamp: new Date(run.updatedAt).toISOString(),
          repos: [{ repo: PRACTICE_REPO, additions: commits.reduce((sum, item) => sum + item.additions, 0), deletions: commits.reduce((sum, item) => sum + item.deletions, 0) }],
          diff: null, checks: implementation?.tests ? [{ context: implementation.tests.command, state: implementation.tests.exitCode === 0 ? "success" : "failure" }] : [],
          findings: null, reviews: null, threads: null, conflicts: null, stack: null, changeset: null } } }).isPersisted.promise
    }
    const applied = readCard(id)!
    await upsert({ ...applied, payload: { ...applied.payload, input: { ...applied.payload.input, liveTutorialAppliedRun: run.runId } } })
  }
  const scheduleLimitExpiry = (id: string, request: Request, limit: LiveTutorialLimit) => {
    if (limit.retryAt === undefined) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!current(id, request)) return
      const card = readCard(id)!
      // Wake the projection without retrying or claiming the server now has capacity.
      const savedLimit = card.payload.input?.liveTutorialLimit as LiveTutorialLimit | undefined
      if (savedLimit?.retryAt === limit.retryAt && !activeLiveTutorialLimit(card)) void upsert({ ...card, payload: { ...card.payload,
        observationError: "The previous practice request was limited. You can try again now." } })
    }, Math.max(0, Math.min(2_147_483_647, limit.retryAt - Date.now())))
    timers.add(timer)
  }
  const failObservation = async (id: string, request: Request, error: unknown) => {
    if (!current(id, request)) return
    const card = readCard(id)!
    const limit = error instanceof TutorialLimitError ? error.limit : undefined
    await upsert({ ...card, ...(limit ? { status: "active" as const } : {}), payload: { ...card.payload,
      // A transport or projection failure is not an execution receipt. Keep
      // the last observed phase so reconnect cannot invent a stopped job.
      observationError: error instanceof Error ? error.message : String(error),
      input: { ...card.payload.input, liveTutorialLimit: limit } } })
    if (limit) scheduleLimitExpiry(id, request, limit)
  }
  // The entire remote lifecycle belongs to the background task, including polling.
  const pause = () => new Promise<void>(resolve => {
    const timer = setTimeout(() => { sleepers.delete(timer); resolve() }, 1000)
    sleepers.set(timer, resolve)
  })
  const send = (id: string, request: Request): Promise<unknown> => {
    const existing = pending.get(request.idempotencyKey)
    if (existing) return existing
    const titles = {
      research: ["Researching issue…", "Research complete"], poc: ["Prototyping fix…", "Prototype ready"],
      plan: ["Preparing plan…", "Plan ready"], implement: ["Implementing fix…", "Implementation ready"],
      change: ["Creating Change…", "Change ready"],
    } as const
    const [title, doneTitle] = titles[request.operation]
    const work = ctx.withToast(`tutorial.${request.idempotencyKey}`, title, doneTitle, async () => {
      try {
        const { operation, conversation: _, ...body } = request
        const response = await ctx.boundedFetch(`${ctx.baseUrl}${LIVE_TUTORIAL_API}/${operation}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        if (response.status === 429) {
          const payload = await response.json().catch(() => null) as { retryAt?: unknown; code?: unknown; message?: unknown } | null
          const at = typeof payload?.retryAt === "string" ? Date.parse(payload.retryAt) : NaN
          const header = response.headers.get("retry-after")
          const seconds = header === null ? NaN : Number(header)
          const fallback = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(header ?? "")
          const retryAt = Number.isFinite(at) ? at : fallback
          throw new TutorialLimitError({ kind: "rate-limit", ...(typeof payload?.code === "string" ? { code: payload.code } : {}),
            ...(typeof payload?.message === "string" && payload.message.length <= 1000 ? { message: payload.message } : {}), ...(Number.isFinite(retryAt) ? { retryAt } : {}) })
        }
        if (!response.ok) throw Error(await ctx.errorMessageOf(response, "The live tutorial workspace could not start."))
        let run = LiveTutorialRunSchema.parse(await response.json())
        if (!current(id, request)) return TOAST_SUPERSEDED
        await publish(id, request, run)
        while (run.phase === "queued" || run.phase === "running") {
          await pause()
          if (!current(id, request)) return TOAST_SUPERSEDED
          const response = await ctx.boundedFetch(`${ctx.baseUrl}${LIVE_TUTORIAL_API}/run/${encodeURIComponent(run.runId)}`, { credentials: "include" })
          if (!response.ok) throw Error(await ctx.errorMessageOf(response, "The live run could not be checked. Reconnect to resume watching it."))
          run = LiveTutorialRunSchema.parse(await response.json())
          if (!current(id, request)) return TOAST_SUPERSEDED
          await publish(id, request, run)
        }
        return run.phase === "failed" ? run.error ?? "The live run failed." : { value: `Live ${operation} ${run.phase === "completed" ? "completed" : "started"}.` }
      } catch (error) { if (!current(id, request)) return TOAST_SUPERSEDED; await failObservation(id, request, error); return error instanceof Error ? error.message : String(error) }
    })
    pending.set(request.idempotencyKey, work)
    void work.finally(() => pending.delete(request.idempotencyKey))
    return work
  }
  const start = async (operation: LiveTutorialOperation, options: { planId?: string; commitIds?: string[] } = {}): Promise<string | { value: string }> => {
    const id = idFor(operation)
    const playthrough = 0
    const old = readCard(id)
    const prior = old && requestOf(old)
    const limit = prior?.playthrough === playthrough ? activeLiveTutorialLimit(old) : undefined
    if (limit) return liveTutorialLimitMessage(limit)
    const snapshot = liveSnapshotOf(old)
    if (prior?.playthrough === playthrough && !LiveTutorialLimitSchema.safeParse(old?.payload.input?.liveTutorialLimit).success
      && old?.payload.phase !== "failed" && snapshot?.phase !== "failed") {
      if (operation !== "change" || JSON.stringify(prior.commitIds) === JSON.stringify(options.commitIds)) {
        if (snapshot?.phase === "completed" && !old?.payload.observationError) { await publish(id, prior, snapshot); return { value: `The live ${operation} is already complete.` } }
        void send(id, prior)
        return { value: `Live ${operation} requested in the background. You can keep chatting.` }
      }
    }
    const request: Request = { ...options, operation, playthrough, idempotencyKey: crypto.randomUUID(), conversation: conversationTabIdOf(ctx.store.session()) }
    await upsert({ id, kind: "run-trace", title: `${operation === "plan" ? "Plan the fix" : operation === "implement" ? "Implement the fix" : operation === "research" ? "Research issue #3" : operation === "poc" ? "Prototype the fix" : "Create the Change"}`,
      status: "active", createdAt: old?.createdAt ?? Date.now(), ordinal: old?.ordinal ?? nextOrdinal(), payload: { repo: PRACTICE_REPO,
        runId: `pending-${request.idempotencyKey}`, workflow: `issue.${operation}`, kind: operation === "plan" ? "change-plan" : operation === "implement" ? "change" : operation,
        phase: "launching", steps: [], result: null, lastSeq: 0, input: { liveTutorial: request } } })
    void send(id, request)
    return { value: `Live ${operation} requested in the background. You can keep chatting.` }
  }
  return {
    inspect: async (cardId: string, eventId: string): Promise<string | void> => {
      const card = readCard(cardId)
      if (!card || !liveSnapshotOf(card)?.events.some(event => event.id === eventId)) return "That step is not in this live run."
      await ctx.store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: cardId, patch: { payload: { selection: card.payload.selection === eventId ? undefined : eventId } } }).isPersisted.promise
    },
    research: () => start("research"),
    poc: () => start("poc"),
    plan: () => start("plan"),
    implement: async (cardId: string) => {
      const card = readCard(cardId)
      const request = card && requestOf(card)
      const plan = liveSnapshotOf(card)?.plan
      if (!plan || request?.playthrough !== (0)) return "Review a live plan before starting implementation."
      const result = await start("implement", { planId: plan.id })
      if (typeof result !== "string") await ctx.store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: cardId, patch: { status: "acted" } }).isPersisted.promise
      return result
    },
    retry: async (cardId: string) => { const card = readCard(cardId); const request = card && requestOf(card); return request ? start(request.operation, { planId: request.planId, commitIds: request.commitIds }) : "This is not a live tutorial run." },
    resume: () => {
      void (async () => {
        for (const card of [...ctx.store.collections.cards.values()].sort((a, b) => a.ordinal - b.ordinal)) {
          if (card.kind !== "run-trace") continue
          const request = requestOf(card)
          if (!request || !current(card.id, request)) continue
          const limit = activeLiveTutorialLimit(card)
          if (limit) scheduleLimitExpiry(card.id, request, limit)
          // A refused request stays manual even after its deadline; it is no run to resume.
          if (LiveTutorialLimitSchema.safeParse(card.payload.input?.liveTutorialLimit).success) continue
          if (card.payload.phase === "failed") continue
          const snapshot = liveSnapshotOf(card)
          if (snapshot?.phase === "completed") {
            await publish(card.id, request, snapshot, true).catch(error => failObservation(card.id, request, error))
            continue
          }
          void send(card.id, request)
        }
      })()
    },
    showDiff: async () => {
      const run = liveSnapshotOf(readCard(PRACTICE_CARD.run))
      if (run?.phase !== "completed" || !run.commits?.length || !run.diff || !run.baseCommitId) return "Wait for the live implementation and its tests to finish."
      const top = run.commits.at(-1)!
      const old = ctx.store.collections.cards.get(PRACTICE_DIFF_CARD)
      await upsert({ id: PRACTICE_DIFF_CARD, kind: "diff", title: "Implementation diff · hello-server", status: "active", createdAt: old?.createdAt ?? Date.now(), ordinal: old?.ordinal ?? nextOrdinal(),
        payload: { repo: PRACTICE_REPO, changeId: top.commitId, from: run.baseCommitId, to: top.commitId, pin: { changeId: top.commitId, seq: null, commitId: top.commitId }, files: run.diff } })
      return { value: run.diff.map(file => `${file.path}\n${file.patch ?? ""}`).join("\n") }
    },
    createChange: (commits: readonly string[]) => start("change", { commitIds: [...commits] }),
  }
}
