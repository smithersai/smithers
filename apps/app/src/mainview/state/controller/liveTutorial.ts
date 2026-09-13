import { LIVE_TUTORIAL_API, LiveTutorialRunSchema, type LiveTutorialOperation, type LiveTutorialRun, type LiveTutorialStart } from "@smthrs/rpc/LiveTutorial"
import type { Card } from "../AppState"
import { conversationTabIdOf } from "../AppState"
import type { ControllerContext } from "./context"
import { PRACTICE_CARD, PRACTICE_REPO } from "../practice/PracticeRepository"
import { lessonCompletion } from "../../onboarding/completion"
import { PRACTICE_DIFF_CARD } from "../seams/DiffFilesSeam"

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
  const pending = new Map<string, Promise<string | { value: string }>>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  ctx.onDispose(() => { disposed = true; for (const timer of timers) clearTimeout(timer); timers.clear() })
  const readCard = (id: string): RunCard | undefined => { const card = ctx.store.collections.cards.get(id); return card?.kind === "run-trace" ? card : undefined }
  const current = (id: string, request: Request) => !disposed && requestOf(readCard(id))?.idempotencyKey === request.idempotencyKey && (ctx.store.session().guide?.playthrough ?? 0) === request.playthrough
  const finish = async (signal: string, playthrough: number) => {
    const guide = ctx.store.session().guide
    if (!guide || (guide.playthrough ?? 0) !== playthrough) return
    const next = lessonCompletion(guide, signal)
    if (next) await ctx.store.dispatch({ type: "guide.changed", actor: "system", guide: next }).isPersisted.promise
  }
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
        input: { ...card.payload.input, liveTutorialSnapshot: run, ...(run.plan ? { liveTutorialPlan: run.plan } : {}) } } })
    if (run.phase !== "completed") return
    if (run.operation === "research" || run.operation === "poc") {
      const catalog = ctx.store.collections.cards.get("practice-issue-flows-3")
      if (catalog?.kind === "workflow-list") await upsert({ ...catalog, payload: { ...catalog.payload, research: run.result ?? "" } })
      if (run.operation === "research") await finish("issue.researched", request.playthrough)
    }
    if (run.operation === "plan" && run.plan) await finish("plan.ready", request.playthrough)
    if (run.operation === "implement") {
      if (!run.commits?.length || !run.diff || !run.files || run.tests?.exitCode !== 0) throw Error("The live run did not return verified commits, files and passing tests.")
      const previous = ctx.store.collections.cards.get(PRACTICE_CARD.commits)
      if (!previous || (previous.kind === "commit-pick" && JSON.stringify(previous.payload.rows.map(row => row.commitId)) !== JSON.stringify(run.commits.map(commit => commit.commitId)))) await upsert({ id: PRACTICE_CARD.commits, kind: "commit-pick", title: `Commits on ${run.branch ?? "tutorial"}`, status: "active", createdAt: previous?.createdAt ?? Date.now(), ordinal: previous?.ordinal ?? nextOrdinal(),
        payload: { repo: PRACTICE_REPO, branch: run.branch ?? "tutorial", targetBookmark: "main",
          rows: run.commits.map((commit, index) => ({ index: index + 1, commitId: commit.commitId, changeId: commit.commitId, message: commit.message,
            additions: commit.additions, deletions: commit.deletions, locked: run.commits!.length === 1 })), picked: run.commits.map((_, index) => index + 1) } })
      await finish("commits.made", request.playthrough)
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
      await finish("change.opened", request.playthrough)
    }
    const applied = readCard(id)!
    await upsert({ ...applied, payload: { ...applied.payload, input: { ...applied.payload.input, liveTutorialAppliedRun: run.runId } } })
  }
  const failObservation = async (id: string, request: Request, error: unknown) => {
    if (!current(id, request)) return
    const card = readCard(id)!
    await upsert({ ...card, payload: { ...card.payload, phase: card.payload.phase === "completed" ? "failed" : "stopped", observationError: error instanceof Error ? error.message : String(error) } })
  }
  const poll = (id: string, request: Request, runId: string) => {
    if (!current(id, request)) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!current(id, request)) return
      void (async () => {
        const response = await ctx.boundedFetch(`${ctx.baseUrl}${LIVE_TUTORIAL_API}/run/${encodeURIComponent(runId)}`, { credentials: "include" })
        if (!response.ok) throw Error(await ctx.errorMessageOf(response, "The live run could not be checked. Reconnect to resume watching it."))
        const run = LiveTutorialRunSchema.parse(await response.json())
        await publish(id, request, run)
        if (run.phase === "queued" || run.phase === "running") poll(id, request, runId)
      })().catch(error => failObservation(id, request, error))
    }, 1000)
    timers.add(timer)
  }
  const send = (id: string, request: Request): Promise<string | { value: string }> => {
    const existing = pending.get(request.idempotencyKey)
    if (existing) return existing
    const work = (async () => {
      try {
        const { operation, conversation: _, ...body } = request
        const response = await ctx.boundedFetch(`${ctx.baseUrl}${LIVE_TUTORIAL_API}/${operation}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        if (!response.ok) throw Error(await ctx.errorMessageOf(response, "The live tutorial workspace could not start."))
        const run = LiveTutorialRunSchema.parse(await response.json())
        await publish(id, request, run)
        if (run.phase === "queued" || run.phase === "running") poll(id, request, run.runId)
        return run.phase === "failed" ? run.error ?? "The live run failed." : { value: `Live ${operation} ${run.phase === "completed" ? "completed" : "started"}.` }
      } catch (error) { await failObservation(id, request, error); return error instanceof Error ? error.message : String(error) }
    })()
    pending.set(request.idempotencyKey, work)
    void work.finally(() => pending.delete(request.idempotencyKey))
    return work
  }
  const start = async (operation: LiveTutorialOperation, options: { planId?: string; commitIds?: string[] } = {}): Promise<string | { value: string }> => {
    const id = idFor(operation)
    const playthrough = ctx.store.session().guide?.playthrough ?? 0
    const old = readCard(id)
    const prior = old && requestOf(old)
    const snapshot = liveSnapshotOf(old)
    if (prior?.playthrough === playthrough && old?.payload.phase !== "failed" && snapshot?.phase !== "failed") {
      if (operation !== "change" || JSON.stringify(prior.commitIds) === JSON.stringify(options.commitIds)) {
        if (snapshot?.phase === "completed") { await publish(id, prior, snapshot); return { value: `The live ${operation} is already complete.` } }
        return send(id, prior)
      }
    }
    const request: Request = { ...options, operation, playthrough, idempotencyKey: crypto.randomUUID(), conversation: conversationTabIdOf(ctx.store.session()) }
    await upsert({ id, kind: "run-trace", title: `${operation === "plan" ? "Plan the fix" : operation === "implement" ? "Implement the fix" : operation === "research" ? "Research issue #3" : operation === "poc" ? "Prototype the fix" : "Create the Change"}`,
      status: "active", createdAt: old?.createdAt ?? Date.now(), ordinal: old?.ordinal ?? nextOrdinal(), payload: { repo: PRACTICE_REPO,
        runId: `pending-${request.idempotencyKey}`, workflow: `issue.${operation}`, kind: operation === "plan" ? "change-plan" : operation === "implement" ? "change" : operation,
        phase: "launching", steps: [], result: null, lastSeq: 0, input: { liveTutorial: request } } })
    return send(id, request)
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
      if (!plan || request?.playthrough !== (ctx.store.session().guide?.playthrough ?? 0)) return "Review a live plan before starting implementation."
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
          if (!request || !current(card.id, request) || card.payload.phase === "failed") continue
          const snapshot = liveSnapshotOf(card)
          if (snapshot?.phase === "completed") {
            await publish(card.id, request, snapshot, true).catch(error => failObservation(card.id, request, error))
            continue
          }
          await send(card.id, request)
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
      await finish("diff.opened", ctx.store.session().guide?.playthrough ?? 0)
      return { value: run.diff.map(file => `${file.path}\n${file.patch ?? ""}`).join("\n") }
    },
    createChange: (commits: readonly string[]) => start("change", { commitIds: [...commits] }),
  }
}
