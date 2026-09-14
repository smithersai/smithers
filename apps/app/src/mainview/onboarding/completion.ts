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

/**
 * The guide after a REPEAT of the current lesson's own act (Back, then the act
 * again). There is no second receipt: the rewound lesson simply resumes, and
 * the shell moves on as it did the first time.
 */
export const lessonResumed = (guide: GuideState | undefined, signal: string): GuideState | undefined => {
  if (guide === undefined || guide.autoPaused !== true) return undefined
  const stage = GUIDE_STAGES[guide.step]
  if (stage?.kind !== "do" || stage.completion !== signal || !guide.completed?.includes(signal)) return undefined
  return { ...guide, autoPaused: false, notice: undefined }
}
