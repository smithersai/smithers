import type { GuideState } from "../state/AppState"
import { GUIDE_BRIDGE, GUIDE_LAST_STEP, GUIDE_STAGES } from "./lessons"

/** ArrowRight is Next only; it never executes a feature or opens the composer. */
export const guideForwardAction = (_step: number): string => "next"

const unreachable = (guide: GuideState, step: number): boolean => {
  const stage = GUIDE_STAGES[step]
  if (stage?.kind !== "do" || stage.requires === undefined) return false
  const declined = guide.declined ?? []
  return stage.requires === "signed-in" ? declined.includes("login") : declined.includes("login") || declined.includes("install")
}

export const guideForwardStep = (guide: GuideState): number => {
  let next = Math.min(GUIDE_LAST_STEP, guide.step + 1)
  while (next < GUIDE_LAST_STEP && unreachable(guide, next)) next += 1
  return next
}

/** Old skipped guides have completion receipts but no saved departure cursor. */
const practiceDeparture = (guide: GuideState): number => guide.practiceSkippedFrom ?? Math.min(GUIDE_BRIDGE - 1,
  Math.max(1, ...GUIDE_STAGES.flatMap((stage, index) =>
    stage.kind === "do" && stage.practice && guide.completed?.includes(stage.completion) ? [index + 1] : [])))

/** Back visits completed beats, plus the beat where an escape hatch was taken. */
export const guideBackwardStep = (guide: GuideState): number => {
  if (guide.step === GUIDE_BRIDGE && guide.declined?.includes("practice")) return practiceDeparture(guide)
  let previous = Math.max(1, guide.step - 1)
  while (previous > 1) {
    const stage = GUIDE_STAGES[previous]
    const declinedHere = previous === GUIDE_BRIDGE && guide.declined?.includes("login")
      || stage?.kind === "do" && stage.completion === "github.app.installed" && guide.declined?.includes("install")
    if (!unreachable(guide, previous) && (stage?.kind !== "do" || guide.completed?.includes(stage.completion) || declinedHere)) break
    previous -= 1
  }
  return previous
}
