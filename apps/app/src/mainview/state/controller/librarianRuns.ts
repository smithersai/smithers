import type { Card, GuideState } from "../AppState"
import type { ControllerContext } from "./context"
import type { WorkflowController } from "./workflows"
import type { CommandResult } from "../../flows/entries/Declare"
import { actorSharedState } from "../ActorBindings"
import { lessonCompletion } from "../../onboarding/completion"
import { LIBRARIAN_LAUNCH_OWNER, LIBRARIAN_UNCONFIRMED, LIBRARIAN_COMMANDS, librarianFailureMessage } from "../LibrarianLaunch"
import { GUIDE_STAGES } from "../../onboarding/lessons"

/** Onboarding SCRIPT v4 beat 12: both background runs launched; the user never has to open either card. */
export const LIBRARIAN_SIGNAL = "librarian.runs.launched"
export const LIBRARIAN_FLOWS = { wiki: "librarian/wiki", history: "librarian/history" } as const
/** Three minutes includes the first cold VM (about 2.5 minutes). Tests shorten only the clock. */
export const librarianLaunchTiming = { deadlineMs: 180_000 }
type LaunchIntent = NonNullable<GuideState["librarianLaunches"]>[number]
const label = (kind: LibrarianKind) => kind === "wiki" ? "Create Wiki" : "Create Mythical history"
export type LibrarianKind = keyof typeof LIBRARIAN_FLOWS
export type LibrarianRunHost = Pick<WorkflowController, "workflowIdentityGuard" | "workflowBalanceGuard" | "workflowTargetRepo" | "provisionWorkspace" | "launchWorkflow">
type RunCard = Extract<Card, { kind: "run-trace" }>
interface ReceiptScope { kind: LibrarianKind; scope: string; inspected: boolean }
const metadata = (card: RunCard): ReceiptScope | undefined => {
  const value = card.payload.input?._librarian
  if (!value || typeof value !== "object") return
  const row = value as Partial<ReceiptScope>
  if ((row.kind === "wiki" || row.kind === "history") && typeof row.scope === "string" && typeof row.inspected === "boolean") return row as ReceiptScope
}

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
      identity?.state === "signed-in" ? identity.login : null, session.guide?.playthrough ?? 0])
  }
  const cards = (): RunCard[] => [...store.collections.cards.values()].filter(card => card.kind === "run-trace")
  const saveIntent = async (entry: LaunchIntent): Promise<boolean> => {
    const guide = store.session().guide
    if (!guide || scope(entry.repo) !== entry.scope) return false
    const entries = [...(guide.librarianLaunches ?? []).filter(row => row.kind !== entry.kind || row.scope !== entry.scope), entry]
    const current = entries.filter(row => row.scope === entry.scope)
    const failure = [...current].reverse().find(row => row.phase === "failed")
    const preparing = current.find(row => row.phase === "preparing" || row.phase === "launching")
    const inline = !guide.finished && GUIDE_STAGES[guide.step]?.kind === "do" && guide.step === 12
    await store.dispatch({ type: "guide.changed", actor: "system", guide: {
      ...guide, librarianLaunches: entries,
      ...(inline ? {
        notice: failure ? librarianFailureMessage(failure.kind, failure.reason) : preparing ? `Preparing your ${preparing.repo} workspace… This can take up to 3 minutes.` : undefined,
        noticeDetail: failure?.reason,
      } : {})
    } }).isPersisted.promise
    return inline
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
    for (const entry of store.session().guide?.librarianLaunches ?? []) {
      if (entry.phase !== "preparing" && entry.phase !== "launching") continue
      if (pending.has(`${entry.kind}:${entry.scope}`)) continue
      const receipt = cards().find(card => card.payload.repo === entry.repo && metadata(card)?.scope === entry.scope && metadata(card)?.kind === entry.kind)
      if (receipt) { await saveIntent({ ...entry, phase: "started" }); await launchedBoth(entry.repo, entry.scope); continue }
      await refuse(entry.kind, entry.phase === "preparing"
        ? "Workspace preparation was interrupted by a reload. Try again."
        : LIBRARIAN_UNCONFIRMED, entry)
    }
  }
  const launch = async (kind: LibrarianKind, repo: string): Promise<CommandResult> => {
    const rejected: LaunchIntent = { kind, repo, scope: scope(repo), phase: "failed", startedAt: Date.now() }
    const guard = runs.workflowIdentityGuard() ?? runs.workflowBalanceGuard()
    if (guard) return refuse(kind, guard, rejected)
    const target = runs.workflowTargetRepo(repo)
    if ("error" in target) return refuse(kind, target.error, rejected)
    const captured = scope(repo)
    const previous = cards().find(card => card.payload.repo === repo && card.payload.workflow === LIBRARIAN_FLOWS[kind] && metadata(card)?.scope === captured)
    if (previous) {
      await saveIntent({ kind, repo, scope: captured, phase: "started", startedAt: previous.createdAt })
      await launchedBoth(repo, captured)
      return { value: `Run ${previous.payload.runId} is already recorded for ${repo}. Open its monitor with /runs.open ${previous.payload.runId}.` }
    }
    const key = `${kind}:${captured}`
    const held = pending.get(key)
    if (held) return held
    const work = (async (): Promise<CommandResult> => {
      const intent: LaunchIntent = { kind, repo, scope: captured, phase: "preparing", startedAt: Date.now(), owner: LIBRARIAN_LAUNCH_OWNER }
      await saveIntent(intent)
      const abort = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const expired = new Promise<string>(resolve => {
          timer = setTimeout(() => {
            resolve("Workspace preparation took longer than 3 minutes. Try again.")
            abort.abort()
          }, librarianLaunchTiming.deadlineMs)
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
        await store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise
        await saveIntent({ ...intent, phase: "started" })
        await launchedBoth(repo, captured)
        return { value: `Started ${label(kind)} on ${repo}. Run ${receipt.runId}.` }
      } catch (error) {
        return refuse(kind, error instanceof Error ? error.message : String(error), intent)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    })()
    pending.set(key, work)
    try { return await work } finally { pending.delete(key) }
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
  /* The lesson completes when BOTH generators have a persisted run for this repository and scope. */
  async function launchedBoth(repo: string, captured: string): Promise<void> {
    if (scope(repo) !== captured) return
    const launched = cards().filter(candidate => candidate.payload.repo === repo && metadata(candidate)?.scope === captured)
    const wiki = launched.find(candidate => metadata(candidate)?.kind === "wiki")
    const history = launched.find(candidate => metadata(candidate)?.kind === "history")
    if (!wiki || !history || wiki.payload.runId === history.payload.runId) return
    const next = lessonCompletion(store.session().guide, LIBRARIAN_SIGNAL)
    if (next !== undefined) await store.dispatch({ type: "guide.changed", actor: ctx.commandActor, guide: next }).isPersisted.promise
  }
  return { recoverLaunches, createWiki: repo => launch("wiki", repo), bootstrapHistory: repo => launch("history", repo), inspectLibrarianRun }
}
