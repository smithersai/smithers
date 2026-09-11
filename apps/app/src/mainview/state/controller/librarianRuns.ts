import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import type { WorkflowController } from "./workflows"
import type { CommandResult } from "../../flows/entries/Declare"
import { actorSharedState } from "../ActorBindings"
import { lessonCompletion } from "../../onboarding/completion"
import { GUIDE_STAGES } from "../../onboarding/lessons"

/** Onboarding SCRIPT v4 beat 12: both background runs launched; the user never has to open either card. */
export const LIBRARIAN_SIGNAL = "librarian.runs.launched"
export const LIBRARIAN_FLOWS = { wiki: "librarian/wiki", history: "librarian/history" } as const
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
  /*
   * Onboarding SCRIPT v4 beat 12 degrades honestly: a launch that cannot
   * start says why under the lesson, instead of failing where the tutorial
   * transcript does not show it (the guide projects cards, not chat lines).
   */
  const refuse = async (kind: LibrarianKind, reason: string): Promise<CommandResult> => {
    const guide = store.session().guide
    const stage = guide === undefined ? undefined : GUIDE_STAGES[guide.step]
    if (guide !== undefined && stage?.kind === "do" && stage.completion === LIBRARIAN_SIGNAL) {
      const notice = `${kind === "wiki" ? "Create Wiki" : "Create Mythical history"} didn't start: ${reason}`
      await store.dispatch({ type: "guide.changed", actor: "system", guide: { ...guide, notice } }).isPersisted.promise
    }
    return reason
  }
  const launch = async (kind: LibrarianKind, repo: string): Promise<CommandResult> => {
    const guard = runs.workflowIdentityGuard() ?? runs.workflowBalanceGuard()
    if (guard) return refuse(kind, guard)
    const target = runs.workflowTargetRepo(repo)
    if ("error" in target) return refuse(kind, target.error)
    const captured = scope(repo)
    const previous = cards().find(card => card.payload.repo === repo && card.payload.workflow === LIBRARIAN_FLOWS[kind] && metadata(card)?.scope === captured)
    if (previous) return { value: `Run ${previous.payload.runId} is already recorded for ${repo}. Open its monitor with /runs.open ${previous.payload.runId}.` }
    const key = `${kind}:${captured}`
    const held = pending.get(key)
    if (held) return held
    const work = (async (): Promise<CommandResult> => {
      const provisioned = await runs.provisionWorkspace(repo)
      if (provisioned !== true) return refuse(kind, provisioned)
      if (scope(repo) !== captured) return refuse(kind, "The repository or account changed before the flow could start.")
      const receipt = await runs.launchWorkflow({ repo, workflow: LIBRARIAN_FLOWS[kind],
        title: `${kind === "wiki" ? "Create Wiki" : "Create Mythical history"} — ${repo}`,
        input: { repo, _librarian: { kind, scope: captured, inspected: false } } })
      if ("message" in receipt) return refuse(kind, receipt.message)
      // A receipt counts only after its actual gateway run card has reached storage.
      const card = cards().find(candidate => candidate.payload.runId === receipt.runId && candidate.payload.repo === repo)
      if (!card) return refuse(kind, "the run started, but its monitor could not be saved. Open it from the run list.")
      await store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise
      await launchedBoth(repo, captured)
      return { value: `Started ${kind === "wiki" ? "Create Wiki" : "Create Mythical history"} on ${repo}. Run ${receipt.runId}.` }
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
    const launched = cards().filter(candidate => candidate.payload.repo === repo && metadata(candidate)?.scope === captured)
    const wiki = launched.find(candidate => metadata(candidate)?.kind === "wiki")
    const history = launched.find(candidate => metadata(candidate)?.kind === "history")
    if (!wiki || !history || wiki.payload.runId === history.payload.runId) return
    const next = lessonCompletion(store.session().guide, LIBRARIAN_SIGNAL)
    if (next !== undefined) await store.dispatch({ type: "guide.changed", actor: ctx.commandActor, guide: next }).isPersisted.promise
  }
  return { createWiki: repo => launch("wiki", repo), bootstrapHistory: repo => launch("history", repo), inspectLibrarianRun }
}
