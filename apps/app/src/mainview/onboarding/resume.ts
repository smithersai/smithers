import type { Card, GuideState } from "../state/AppState"
import { PRACTICE_REPO } from "../state/practice/PracticeRepository"
import { GUIDE_LAST_STEP, GUIDE_STAGES } from "./lessons"

/** Recover an entry cursor from durable tutorial evidence, never replay an action. */
function resumeCursor(guide: GuideState, cards: Iterable<Card>, hasMessages = false): GuideState {
  if (guide.finished || guide.step > 1 || (guide.step === 1 && (guide.completed?.length ?? 0) > 0)) return guide
  const completed = new Set(guide.completed ?? [])
  let history = completed.size > 0 || (hasMessages && (guide.playthrough ?? 0) === 0)
  let latest = 0
  for (const card of cards) {
    if (!("repo" in card.payload) || card.payload.repo !== PRACTICE_REPO) continue
    // A deliberate replay must not adopt artifacts left by the previous run.
    const scope = card.kind === "run-trace" ? card.payload.input?.tutorialScope : undefined
    const scopedPlaythrough = scope !== null && typeof scope === "object" && "playthrough" in scope ? scope.playthrough : undefined
    if (scopedPlaythrough !== undefined && scopedPlaythrough !== (guide.playthrough ?? 0)) continue
    if ((guide.playthrough ?? 0) > 0 && scopedPlaythrough === undefined && !completed.has("tutorial.started")) continue
    history = true
    const signal = card.kind === "issue-list" ? "issues.opened" : card.kind === "issue" ? "issue.opened"
      : card.kind === "commit-pick" ? "commits.made" : card.kind === "change" ? "change.opened"
      : card.kind === "run-trace" && card.payload.kind === "change-plan" ? "plan.ready" : undefined
    if (signal !== undefined) completed.add(signal)
  }
  if (!history) return guide.step === 0 ? { ...guide, step: 1 } : guide
  completed.add("tutorial.started")
  GUIDE_STAGES.forEach((stage, index) => {
    if (stage.kind === "do" && completed.has(stage.completion)) latest = Math.max(latest, index)
  })
  // Resume at the furthest recorded lesson so its result and next action are
  // visible. The normal Continue transition advances it without rerunning it.
  return { ...guide, completed: [...completed], step: Math.min(GUIDE_LAST_STEP, Math.max(1, latest)), autoPaused: true }
}

/** Keep old transcripts, but never treat a recorded demo plan as a live agent plan. */
export function resumeTutorial(guide: GuideState, cards: Iterable<Card>, hasMessages = false): GuideState {
  const rows = [...cards]
  const resumed = resumeCursor(guide, rows, hasMessages)
  if (resumed.finished || resumed.step < 4 || resumed.step > 9) return resumed
  const example = rows.filter(card => "repo" in card.payload && card.payload.repo === PRACTICE_REPO)
  const hasLiveRun = example.some(card => {
    const request = card.kind === "run-trace" ? card.payload.input?.liveTutorial as { playthrough?: unknown } | undefined : undefined
    return request?.playthrough === (resumed.playthrough ?? 0)
  })
  const hasRecordedWork = example.some(card => card.kind === "commit-pick" || card.kind === "change" ||
    (card.kind === "run-trace" && card.payload.input?.practice === true))
  if (hasLiveRun || !hasRecordedWork) return resumed
  const agentSignals = new Set(["issue.researched", "plan.ready", "commits.made", "diff.opened", "diff.file.opened", "change.opened"])
  return { ...resumed, step: 4, pick: undefined, autoPaused: true, completed: (resumed.completed ?? []).filter(signal => !agentSignals.has(signal)) }
}


/**
 * Root/Start Here and ?tutorial are explicit tutorial entries. A durable frame
 * address resumes its stored view even though it uses the same onboarding shell;
 * rendering mode is not permission to restart a finished playthrough.
 */
export function shouldReplayTutorial(mode: "onboarding" | "repo" | undefined, search: string, guide: GuideState | undefined, pathname: string): boolean {
  if (mode !== "onboarding" || !guide?.finished) return false
  const params = new URLSearchParams(search)
  if (!params.has("tutorial") && pathname !== "/") return false
  return !params.has("signed-in") && !params.has("installation_id") && !["failed", "error"].includes(params.get("auth") ?? "")
}
