import { createContext } from "react"
import type { Card, GuideState } from "../state/AppState"
import { GUIDE_STAGES } from "./lessons"

/** Only explicit guide ownership or durable practice provenance enters a lesson. */
export const tutorialTranscript = <Row extends { id: string; payload: object }>(
  cards: ReadonlyArray<Row>, transcript: GuideState["transcript"] = {},
): Array<Row> => cards.filter(card => transcript[card.id]?.owned === true || isTutorialCard(card))

/** Positive producer provenance, never a list of workspace kinds to exclude. */
export function isLessonCard(card: Card, guide: GuideState): boolean {
  if (isTutorialCard(card) || card.id === `tutorial-repository-${guide.playthrough ?? 0}`) return true
  if (card.kind === "flow-form") {
    const lesson = GUIDE_STAGES[guide.step]
    return lesson?.kind === "do" && (lesson.actions.some(action => action.flow === card.payload.flow)
      || (guide.step === 11 && card.payload.flow === "github.app.choose"))
  }
  if (card.kind === "run-trace") {
    const origin = card.payload.input?._librarian as { scope?: string; kind?: string } | undefined
    return origin != null && guide.step === 12 && guide.librarianLaunches?.some(launch =>
      launch.scope === origin.scope && launch.kind === origin.kind && launch.repo === card.payload.repo) === true
  }
  return false
}

/** True beneath GuideShell: the app is the tutorial's workspace, not a repository route's. */
export const InTutorial = createContext(false)

/** Lesson cards stay with their read; chat rows retain their recorded place. */
export function guideTranscriptEntries(
  cards: ReadonlyArray<import("../state/AppState").Card>,
  messages: ReadonlyArray<import("../state/AppState").Message>,
  guide: import("../state/AppState").GuideState,
) {
  const recorded = guide.transcript ?? {}
  const latestLesson = Math.max(-1, ...cards.filter(card => recorded[card.id]?.source !== "chat")
    .map(card => recorded[card.id]?.step ?? guide.step))
  return [
    ...cards.map(card => {
      const at = recorded[card.id]
      const step = at?.step ?? guide.step
      return { kind: "card" as const, card, step: at?.source !== "chat" && step === latestLesson ? guide.step : Math.min(step, guide.step), ordinal: at?.ordinal ?? card.ordinal }
    }),
    ...messages.map(message => ({ kind: "message" as const, message,
      step: Math.min(recorded[message.id]?.step ?? 0, guide.step), ordinal: message.ordinal })),
  ].sort((a, b) => a.step - b.step || a.ordinal - b.ordinal)
}

/**
 * At the handoff, show the repository the user selected, including its entry
 * cards. A card a chat turn produced keeps its place in the guide transcript
 * beside the reply that made it, so the workspace beneath does not repeat it.
 */
export const workspaceTranscript = <Row extends { id?: string; payload: object }>(
  cards: ReadonlyArray<Row>, repo: string | null, omittedCardIds: ReadonlySet<string> = new Set(),
  explicitTutorialCardIds: ReadonlySet<string> = new Set(),
): Array<Row> =>
  cards.filter(card => (!isTutorialCard(card) || (card.id !== undefined && explicitTutorialCardIds.has(card.id)))
    && (card.id === undefined || !omittedCardIds.has(card.id))
    && (repo === null || !("repo" in card.payload) || typeof card.payload.repo !== "string" || card.payload.repo === repo))

/** Practice frames retain their provenance even when an older payload lost its repo key. */
export function isTutorialCard(card: { id?: string; payload: object }): boolean {
  const payload = card.payload as { repo?: unknown; input?: { liveTutorial?: unknown } }
  return typeof payload.repo === "string" && payload.repo.startsWith("practice:")
    || payload.input?.liveTutorial !== undefined
    || /^(practice-|live-tutorial-|flow-run-practice-)/.test(card.id ?? "")
}

/** The ids the guide recorded as arriving from a chat turn during this playthrough. */
export const chatEntryIds = (
  transcript: Readonly<Record<string, { readonly source: "chat" | "lesson"; readonly owned?: true }>> | undefined,
): ReadonlySet<string> =>
  new Set(Object.entries(transcript ?? {}).filter(([, at]) => at.source === "chat" && at.owned === true).map(([id]) => id))
