import { actorSharedState } from "../ActorBindings"
import type { Card,Session } from "../AppState"
import { LIBRARIAN_HISTORY_FLOW,LIBRARIAN_UNCONFIRMED,librarianFailureMessage,librarianReceiptFor,librarianRunMetadata } from "../LibrarianLaunch"
import type { ControllerContext } from "./context"
import type { WorkflowController } from "./workflows"

type LaunchIntent = NonNullable<Session["librarianLaunches"]>[number]
export type LibrarianRunHost = Pick<WorkflowController, "workflowTargetRepo">
type RunCard = Extract<Card, { kind: "run-trace" }>
const metadata = librarianRunMetadata

export interface LibrarianRunsController {
  readonly recoverLaunches: () => Promise<void>
  /** Call only after a successful gateway read has rendered this run's monitor. */
  readonly inspectLibrarianRun: (runId: string) => Promise<void>
}

/*
 * `history` intents persisted before #1760 still recover to their run's
 * receipt; Create now asks the server (StackSeam). A persisted `wiki` intent
 * (the retired per-folder generator) is dropped: the stack refreshes the Wiki.
 * Receipts and inspection live in persisted run-card input, not a parallel
 * state authority.
 */
export const createLibrarianRunsController = (ctx: ControllerContext, runs: LibrarianRunHost): LibrarianRunsController => {
  const { store } = ctx
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
  const saveIntent = async (entry: LaunchIntent): Promise<void> => {
    if (scope(entry.repo) !== entry.scope) return
    const entries = [...(store.session().librarianLaunches ?? []).filter(row => row.kind !== entry.kind || row.scope !== entry.scope), entry]
    await store.dispatch({ type: "librarian.launches.changed", actor: "system", launches: entries }).isPersisted.promise
    if (entry.phase === "failed") {
      const key = toastKey(entry)
      const title = librarianFailureMessage(entry.reason)
      const shown = store.collections.toasts.get(`toast-${key}`)
      if (shown?.status !== "failed" || shown.title !== title) {
        await store.dispatch({ type: "toast.shown", actor: "system", key, title }).isPersisted.promise
        await store.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail: "",
          action: { flow: "history.bootstrap", args: entry.repo, label: "Retry Mythical history" }
        }).isPersisted.promise
      }
    } else {
      const toast = store.collections.toasts.get(`toast-${toastKey(entry)}`)
      if (toast) await store.dispatch({ type: "toast.dismissed", actor: "system", id: toast.id }).isPersisted.promise
    }
  }
  /** Retired wiki intents leave the session on the first load that sees them. */
  const dropWikiLaunches = async (): Promise<void> => {
    const launches = store.session().librarianLaunches ?? []
    if (!launches.some(row => row.kind === "wiki")) return
    await store.dispatch({ type: "librarian.launches.changed", actor: "system",
      launches: launches.filter(row => row.kind !== "wiki") }).isPersisted.promise
  }
  /** A reload reports interrupted preparation; it never blindly repeats a possibly submitted launch. */
  const recoverLaunches = async (): Promise<void> => {
    await dropWikiLaunches()
    await reconcile()
    for (const entry of store.session().librarianLaunches ?? []) {
      // Toasts are transient; the durable intent restores the Retry door after reload.
      if (entry.phase === "failed") { await saveIntent(entry); continue }
      if (entry.phase !== "preparing" && entry.phase !== "launching") continue
      const recorded = receiptFor(entry)
      const receipt = recorded && recorded.createdAt >= entry.startedAt ? recorded : undefined
      if (receipt) { await saveReceipt(entry, receipt); continue }
      await saveIntent({ ...entry, phase: "failed", reason: entry.phase === "preparing"
        ? "Workspace preparation was interrupted by a reload. Try again."
        : LIBRARIAN_UNCONFIRMED })
    }
    await reconcile()
  }
  const inspectLibrarianRun = async (runId: string): Promise<void> => {
    const card = cards().find(card => card.payload.runId === runId)
    if (!card) return
    const receipt = metadata(card)
    const target = runs.workflowTargetRepo()
    if (!receipt || "error" in target || target.repo !== card.payload.repo || receipt.scope !== scope(target.repo) || card.payload.workflow !== LIBRARIAN_HISTORY_FLOW) return
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
      if (entry.kind === "wiki" || entry.scope !== scope(entry.repo)) continue
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
  return { recoverLaunches, inspectLibrarianRun }
}
