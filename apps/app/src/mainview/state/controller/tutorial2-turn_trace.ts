import { Schema } from "effect"
import { Plan } from "../../../../../../flows/coding/schema"
import { decodeChangeReceipt, receiptMatchesPlan } from "../../cards/tutorial2-agent_change-contract"
import type { AppStore } from "../AppStore"
import type { GuideState } from "../AppState"
import type { TraceModel } from "../../cards/RunTrace"
import { spanPath } from "../../cards/RunTrace"
import { GUIDE_STAGES } from "../../onboarding/lessons"

/** Persisted by the change producer after a verified commit; root supplies this read seam. */
export interface TutorialTraceScope {
  readonly runId: string
  readonly repo: string
  readonly playthrough: number
}

/** Only an explicit inspection of the matching turn's recorded source and calls is evidence. */
export function canCompleteTutorialTrace(
  guide: GuideState | undefined,
  scope: TutorialTraceScope | undefined,
  activeRepo: string | null,
  runId: string,
  repo: string,
  model: TraceModel,
  nodeId: string
): boolean {
  if (!guide || !scope || scope.runId !== runId || scope.repo !== repo || activeRepo !== repo ||
      scope.playthrough !== (guide.playthrough ?? 0) || !guide.completed?.includes("change.committed")) return false
  const stage = GUIDE_STAGES[guide.step]
  if (stage?.kind !== "do" || stage.completion !== "trace.opened") return false
  const frame = spanPath(model, nodeId).find(span => span.kind === "frame")
  if (!frame) return false
  const rows = model.rows.filter(span => spanPath(model, span.id).some(parent => parent.id === frame.id))
  return rows.some(span => typeof span.detail.source === "string" && span.detail.source.trim() !== "" &&
    !span.detail.source.trim().startsWith('{"truncated":')) && rows.some(span => span.kind === "call")
}

/** Read the change lane's existing durable receipt; never infer a run from its title or age. */
export function tutorialTraceScopeFor(store: AppStore, runId?: string): TutorialTraceScope | undefined {
  const session = store.session()
  for (const card of store.collections.cards.values()) {
    if (card.kind !== "run-trace" || card.payload.kind !== "change" || card.payload.phase !== "completed" ||
        (runId !== undefined && card.payload.runId !== runId)) continue
    const input = card.payload.input
    const scope = input?.tutorialScope as { repoKey?: unknown; playthrough?: unknown } | undefined
    if (!scope || scope.repoKey !== session.activeRepoKey || scope.playthrough !== (session.guide?.playthrough ?? 0)) continue
    try {
      const receipt = decodeChangeReceipt(input?.tutorialReceipt)
      const plan = Schema.decodeUnknownSync(Plan)(input?.plan)
      if (receiptMatchesPlan(receipt, plan, card.payload.repo, card.payload.runId)) {
        return { runId: card.payload.runId, repo: card.payload.repo, playthrough: session.guide?.playthrough ?? 0 }
      }
    } catch { /* Missing or malformed receipts never complete the trace lesson. */ }
  }
  return undefined
}
