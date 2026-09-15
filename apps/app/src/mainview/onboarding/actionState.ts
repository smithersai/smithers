import { LiveTutorialRunSchema, type LiveTutorialOperation } from "@smthrs/rpc/LiveTutorial"
import type { Card, GuideState } from "../state/AppState"
import { LIBRARIAN_LAUNCH_OWNER, LIBRARIAN_COMMANDS, legacyLibrarianFailure, librarianLaunchFor } from "../state/LibrarianLaunch"
import type { GuideAction } from "./lessons"
import { completedGuideAction } from "./advance"
import { activeLiveTutorialLimit } from "../state/LiveTutorialLimit"

const liveActions: Readonly<Record<string, { operation: LiveTutorialOperation; busy: string; retry: string; complete: string; completion: string }>> = {
  "issue.repro": { operation: "research", busy: "Researching issue…", retry: "Retry repro", complete: "Research complete", completion: "issue.researched" },
  "issue.implement": { operation: "plan", busy: "Preparing plan…", retry: "Retry plan", complete: "Plan ready", completion: "plan.ready" },
  "agent.change.start": { operation: "implement", busy: "Implementing fix…", retry: "Retry implementation", complete: "Implementation ready", completion: "commits.made" },
  "change.open": { operation: "change", busy: "Creating Change…", retry: "Retry Change", complete: "Change ready", completion: "change.opened" },
}

/** This page load: a GitHub App check persisted by an earlier load is not in flight here. */
export const INSTALL_CHECK_OWNER = crypto.randomUUID()

/** The suggestion and its shortcut share the current persisted run's state. */
export function guideActionState(action: GuideAction, cards: readonly Card[], guide: GuideState): GuideAction & { disabled?: boolean; busy?: boolean } {
  if (completedGuideAction(action, guide)) return { ...action, flow: "onboarding.act", args: "next" }
  // Verifying pages the whole GitHub inventory; without a label the pill looks dead for seconds.
  if (action.flow === "github.app.open" && guide.installCheck === INSTALL_CHECK_OWNER) return { ...action, label: "Checking GitHub…", disabled: true, busy: true }
  const background = action.flow === LIBRARIAN_COMMANDS.wiki ? "wiki" : action.flow === LIBRARIAN_COMMANDS.history ? "history" : undefined
  if (background && legacyLibrarianFailure(guide)?.kind === background) return { ...action, label: background === "wiki" ? "Retry Wiki" : "Retry Mythical history" }
  const launch = background && librarianLaunchFor(guide, background)
  if (launch) {
    const label = background === "wiki" ? "Wiki" : "Mythical history"
    const preparing = launch.phase === "preparing" || launch.phase === "launching"
    if (preparing && launch.owner === LIBRARIAN_LAUNCH_OWNER) return { ...action, label: `Preparing ${label}…`, disabled: true, busy: true }
    if (launch.phase === "failed" || preparing) return { ...action, label: `Retry ${label}` }
    if (launch.phase === "started") return { ...action, label: `${label} started`, disabled: true }
  }
  const operation = liveActions[action.flow]
  if (!operation) return action
  const card = cards.find(card => {
    if (card.kind !== "run-trace") return false
    const request = card.payload.input?.liveTutorial as { operation?: string; playthrough?: number } | undefined
    return request?.operation === operation.operation && request.playthrough === (guide.playthrough ?? 0)
  })
  if (card?.kind !== "run-trace") return action
  if (activeLiveTutorialLimit(card)) return { ...action, label: "Continue without practice", flow: "onboarding.act", args: "skip-practice" }
  const parsed = LiveTutorialRunSchema.safeParse(card.payload.input?.liveTutorialSnapshot)
  const run = parsed.success ? parsed.data : undefined
  const failure = card.payload.observationError ?? run?.error
  if (failure?.toLowerCase().includes("expired")) return { ...action, label: "Start new tutorial", flow: "onboarding.act", args: "restart" }
  if (card.payload.phase === "failed" || run?.phase === "failed") return { ...action, label: operation.retry, flow: "tutorial.live.retry", args: card.id }
  if (failure) return { ...action, label: run ? "Reconnect to run" : operation.retry, flow: "tutorial.live.retry", args: card.id }
  if (card.payload.phase === "launching" || card.payload.phase === "running") return { ...action, label: operation.busy, disabled: true, busy: true }
  if (card.payload.phase === "completed" && guide.completed?.includes(operation.completion)) return { ...action, label: operation.complete, disabled: true }
  return action
}
