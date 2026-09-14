import { LiveTutorialRunSchema, type LiveTutorialOperation } from "@smthrs/rpc/LiveTutorial"
import type { Card, GuideState } from "../state/AppState"
import type { GuideAction } from "./lessons"

const liveActions: Readonly<Record<string, { operation: LiveTutorialOperation; busy: string; retry: string; complete: string; completion: string }>> = {
  "issue.repro": { operation: "research", busy: "Researching issue…", retry: "Retry repro", complete: "Research complete", completion: "issue.researched" },
  "issue.implement": { operation: "plan", busy: "Preparing plan…", retry: "Retry plan", complete: "Plan ready", completion: "plan.ready" },
  "agent.change.start": { operation: "implement", busy: "Implementing fix…", retry: "Retry implementation", complete: "Implementation ready", completion: "commits.made" },
  "change.open": { operation: "change", busy: "Creating Change…", retry: "Retry Change", complete: "Change ready", completion: "change.opened" },
}

/** The suggestion and its shortcut share the current persisted run's state. */
export function guideActionState(action: GuideAction, cards: readonly Card[], guide: GuideState): GuideAction & { disabled?: boolean; busy?: boolean } {
  const operation = liveActions[action.flow]
  if (!operation) return action
  const card = cards.find(card => {
    if (card.kind !== "run-trace") return false
    const request = card.payload.input?.liveTutorial as { operation?: string; playthrough?: number } | undefined
    return request?.operation === operation.operation && request.playthrough === (guide.playthrough ?? 0)
  })
  if (card?.kind !== "run-trace") return action
  const parsed = LiveTutorialRunSchema.safeParse(card.payload.input?.liveTutorialSnapshot)
  const run = parsed.success ? parsed.data : undefined
  const failure = card.payload.observationError ?? run?.error
  if (failure?.toLowerCase().includes("expired")) return { ...action, label: "Start new tutorial", flow: "onboarding.act", args: "restart" }
  if (card.payload.phase === "failed" || run?.phase === "failed") return { ...action, label: operation.retry, flow: "tutorial.live.retry", args: card.id }
  if (failure) return { ...action, label: "Reconnect to run", flow: "tutorial.live.retry", args: card.id }
  if (card.payload.phase === "launching" || card.payload.phase === "running") return { ...action, label: operation.busy, disabled: true, busy: true }
  if (card.payload.phase === "completed" && guide.completed?.includes(operation.completion)) return { ...action, label: operation.complete, disabled: true }
  return action
}
