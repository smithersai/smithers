import type { GuideState } from "../state/AppState"
import { GUIDE_STAGES } from "./lessons"

/** Record a finished signal, and the producer's success line when it has one. */
export const completeGuide = (guide: GuideState, signal: string, said?: string): GuideState => ({
  ...guide,
  completed: [...new Set([...(guide.completed ?? []), signal])],
  autoPaused: false,
  ...(said === undefined ? {} : { said: { ...guide.said, [signal]: said } }),
  notice: undefined,
})

/**
 * The guide after `signal`, when the CURRENT lesson waits on exactly that
 * signal and has not seen it; undefined otherwise. Producers key on the
 * lesson's completion signal, never on a step number.
 */
export const lessonCompletion = (guide: GuideState | undefined, signal: string, said?: string): GuideState | undefined => {
  if (guide === undefined) return undefined
  const stage = GUIDE_STAGES[guide.step]
  if (stage?.kind !== "do" || stage.completion !== signal || guide.completed?.includes(signal)) return undefined
  return completeGuide(guide, signal, said)
}
