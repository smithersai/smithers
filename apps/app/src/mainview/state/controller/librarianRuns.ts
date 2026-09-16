import type { CommandResult } from "../../flows/entries/Declare"
import { actorSharedState } from "../ActorBindings"
import type { Card,Session } from "../AppState"
import { LIBRARIAN_COMMANDS,LIBRARIAN_LAUNCH_OWNER,LIBRARIAN_UNCONFIRMED,librarianFailureMessage,librarianReceiptFor,librarianRunMetadata } from "../LibrarianLaunch"
import type { ControllerContext } from "./context"
import type { WorkflowController } from "./workflows"

/** Onboarding SCRIPT v4 beat 12: both background runs launched; the user never has to open either card. */
export const LIBRARIAN_FLOWS = { wiki: "librarian/wiki", history: "librarian/history" } as const
/** Three minutes includes the first cold VM (about 2.5 minutes). Tests shorten only the clock. */
export const librarianLaunchTiming = { deadlineMs: 180_000 }
type LaunchIntent = NonNullable<Session["librarianLaunches"]>[number]
const label = (kind: LibrarianKind) => kind === "wiki" ? "Create Wiki" : "Create Mythical history"
export type LibrarianKind = keyof typeof LIBRARIAN_FLOWS
export type LibrarianRunHost = Pick<WorkflowController, "workflowIdentityGuard" | "workflowBalanceGuard" | "workflowTargetRepo" | "provisionWorkspace" | "launchWorkflow">
type RunCard = Extract<Card, { kind: "run-trace" }>
const metadata = librarianRunMetadata

export interface LibrarianRunsController {
  readonly recoverLaunches: () => Promise<void>
  readonly createWiki: (repo: string) => Promise<CommandResult>
  readonly bootstrapHistory: (repo: string) => Promise<CommandResult>
  /** Call only after a successful gateway read has rendered this run's monitor. */
  readonly inspectLibrarianRun: (runId: string) => Promise<void>
}

/** Receipts and inspection live in persisted run-card input, not a parallel state authority. */
export const createLibrarianRunsController = (ctx: ControllerContext, runs: LibrarianRunHost): LibrarianRunsController => {
  const { store } = ctx
  const pending = actorSharedState(ctx, "librarian-launches", () => new Map<string, Promise<CommandResult>>())
  const scope = (repo: string) => {
    const session = store.session()
    const identity = store.collections.identitySessions.get("identity")
    return JSON.stringify([repo, session.activeRepoKey, session.activeWorkspaceId, session.activeBranchId,
      identity?.state === "signed-in" ? identity.login : null, 0])
  }
  const cards = (): RunCard[] => [...store.collections.cards.values()].filter(card => card.kind === "run-trace")
    .sort((a, b) => b.ordinal - a.ordinal)
  const receiptFor = (entry: LaunchIntent) => librarianReceiptFor(cards(), entry)
  const toastKey = (entry: LaunchIntent) => `librarian.failed.${entry.kind}.${entry.scope}`
  const saveIntent = async (entry: LaunchIntent): Promise<boolean> => {
    if (scope(entry.repo) !== entry.scope) return false
    const entries = [...(store.session().librarianLaunches ?? []).filter(row => row.kind !== entry.kind || row.scope !== entry.scope), entry]
    await store.dispatch({ type: "librarian.launches.changed", actor: "system", launches: entries }).isPersisted.promise
    if (entry.phase === "failed") {
      const key = toastKey(entry)
      const title = librarianFailureMessage(entry.kind, entry.reason)
      const shown = store.collections.toasts.get(`toast-${key}`)
      if (shown?.status !== "failed" || shown.title !== title) {
        await store.dispatch({ type: "toast.shown", actor: "system", key, title }).isPersisted.promise
        await store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail: "",
          action: { flow: LIBRARIAN_COMMANDS[entry.kind], args: entry.repo, label: entry.kind === "wiki" ? "Retry Wiki" : "Retry Mythical history" }
        }).isPersisted.promise
      }
    } else {
      const toast = store.collections.toasts.get(`toast-${toastKey(entry)}`)
      if (toast) await store.dispatch({ type: "toast.dismissed", actor: "system", id: toast.id }).isPersisted.promise
    }
    return false
  }
  const refuse = async (kind: LibrarianKind, reason: string, entry: LaunchIntent): Promise<CommandResult> => {
    if (await saveIntent({ ...entry, phase: "failed", reason })) {
      // The lesson owns this failure; do not repeat it in preparation or command toasts.
      for (const toast of store.collections.toasts.values()) {
        if (toast.key.startsWith(`flow.provision.${entry.repo}.`) || toast.key === `command.failed.${LIBRARIAN_COMMANDS[kind]}`) {
          await store.dispatch({ type: "toast.dismissed", actor: "system", id: toast.id }).isPersisted.promise
        }
      }
    }
    return reason
  }
  /** A reload reports interrupted preparation; it never blindly repeats a possibly submitted launch. */
  const recoverLaunches = async (): Promise<void> => {
    await reconcile()
    for (const entry of store.session().librarianLaunches ?? []) {
      // Toasts are transient; the durable intent restores the Retry door after reload.
      if (entry.phase === "failed") { await saveIntent(entry); continue }
      if (entry.phase !== "preparing" && entry.phase !== "launching") continue
      if (pending.has(`${entry.kind}:${entry.scope}`)) continue
      const recorded = receiptFor(entry)
      const receipt = recorded && recorded.createdAt >= entry.startedAt ? recorded : undefined
      if (receipt) { await saveReceipt(entry, receipt); continue }
      await refuse(entry.kind, entry.phase === "preparing"
        ? "Workspace preparation was interrupted by a reload. Try again."
        : LIBRARIAN_UNCONFIRMED, entry)
    }
    await reconcile()
  }
  const launch = async (kind: LibrarianKind, repo: string): Promise<CommandResult> => {
    const rejected: LaunchIntent = { kind, repo, scope: scope(repo), phase: "failed", startedAt: Date.now() }
    const guard = runs.workflowIdentityGuard() ?? runs.workflowBalanceGuard()
    if (guard) return refuse(kind, guard, rejected)
    const target = runs.workflowTargetRepo(repo)
    if ("error" in target) return refuse(kind, target.error, rejected)
    const captured = scope(repo)
    const key = `${kind}:${captured}`
    const held = pending.get(key)
    if (held) return held
    const previous = receiptFor({ ...rejected, scope: captured, startedAt: 0 })
    if (previous && previous.payload.phase !== "failed") {
      await saveReceipt({ kind, repo, scope: captured, phase: "started", startedAt: previous.createdAt }, previous)
      return { value: `Run ${previous.payload.runId} is already recorded for ${repo}. Open its monitor with /runs.open ${previous.payload.runId}.` }
    }
    const work = (async (): Promise<CommandResult> => {
      const intent: LaunchIntent = { kind, repo, scope: captured, phase: "preparing", startedAt: Date.now(), owner: LIBRARIAN_LAUNCH_OWNER }
      await saveIntent(intent)
      const abort = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // The preparing notice is visible before saveIntent finishes persisting.
        // Count that time too, and never provision an already expired intent.
        const remainingMs = intent.startedAt + librarianLaunchTiming.deadlineMs - Date.now()
        const deadlineFailure = "Workspace preparation took longer than 3 minutes. Try again."
        if (remainingMs <= 0) return refuse(kind, deadlineFailure, intent)
        const expired = new Promise<string>(resolve => {
          timer = setTimeout(() => {
            resolve(deadlineFailure)
            abort.abort()
          }, remainingMs)
        })
        const provisioned = await Promise.race([runs.provisionWorkspace(repo, undefined, abort.signal), expired])
        if (timer !== undefined) clearTimeout(timer)
        if (provisioned !== true) return refuse(kind, provisioned, intent)
        if (scope(repo) !== captured) return refuse(kind, "The repository or account changed before the flow could start.", intent)
        await saveIntent({ ...intent, phase: "launching" })
        const receipt = await runs.launchWorkflow({ repo, workflow: LIBRARIAN_FLOWS[kind],
          title: `${label(kind)} — ${repo}`,
          input: { repo, _librarian: { kind, scope: captured, inspected: false } } })
        if ("message" in receipt) return refuse(kind, receipt.message, intent)
        const card = cards().find(candidate => candidate.payload.runId === receipt.runId && candidate.payload.repo === repo)
        if (!card) return refuse(kind, "the run started, but its monitor could not be saved. Open it from the run list.", intent)
        await saveReceipt(intent, card)
          if (card.payload.phase === "failed") return card.payload.error ?? librarianFailureMessage(kind)
        return { value: `Started ${label(kind)} on ${repo}. Run ${receipt.runId}.` }
      } catch (error) {
        return refuse(kind, error instanceof Error ? error.message : String(error), intent)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    })()
    pending.set(key, work)
    try { return await work } finally { pending.delete(key); await reconcile() }
  }
  const inspectLibrarianRun = async (runId: string): Promise<void> => {
    const card = cards().find(card => card.payload.runId === runId)
    if (!card) return
    const receipt = metadata(card)
    const target = runs.workflowTargetRepo()
    if (!receipt || "error" in target || target.repo !== card.payload.repo || receipt.scope !== scope(target.repo) || card.payload.workflow !== LIBRARIAN_FLOWS[receipt.kind]) return
    await store.dispatch({ type: "card.updated", actor: ctx.commandActor, id: card.id,
      patch: { payload: { ...card.payload, input: { ...card.payload.input, _librarian: { ...receipt, inspected: true } } } }
    }).isPersisted.promise
  }
  async function saveReceipt(entry: LaunchIntent, card: RunCard): Promise<void> {
    await saveIntent({ ...entry, runId: card.payload.runId,
      phase: card.payload.phase === "failed" ? "failed" : "started",
      reason: card.payload.phase === "failed" ? card.payload.error : undefined })
  }
  /** Card updates are the authority, including failures after launch acknowledgement and reload. */
  async function reconcile(): Promise<void> {
    for (const entry of store.session().librarianLaunches ?? []) {
      if (entry.scope !== scope(entry.repo) || pending.has(`${entry.kind}:${entry.scope}`)) continue
      const card = receiptFor(entry)
      if (!card) continue
      const phase = card.payload.phase === "failed" ? "failed" : "started"
      const reason = card.payload.phase === "failed" ? card.payload.error : undefined
      if (entry.phase !== phase || entry.runId !== card.payload.runId || entry.reason !== reason) {
        await saveReceipt(entry, card)
      }
    }
  }
  actorSharedState(ctx, "librarian-run-observation", () => {
    let queued = false
    let dirty = false
    let disposed = false
    const changed = () => {
      if (disposed) return
      dirty = true
      if (queued) return
      queued = true
      queueMicrotask(async () => {
        try {
          while (dirty && !disposed) { dirty = false; await reconcile() }
        } finally { queued = false }
      })
    }
    const subscriptions = [store.collections.cards.subscribeChanges(changed), store.collections.sessions.subscribeChanges(changed)]
    ctx.onDispose(() => { disposed = true; for (const subscription of subscriptions) subscription.unsubscribe() })
    return subscriptions
  })
  return { recoverLaunches, createWiki: repo => launch("wiki", repo), bootstrapHistory: repo => launch("history", repo), inspectLibrarianRun }
}
