import type { GuideState } from "../state/AppState"
import { GUIDE_STAGES, type GuideAction } from "./lessons"

/*
 * Chat re-completes its own beat, and C opens it from anywhere, so it keeps its
 * door: openPalette resumes the rewound lesson (state/AppController.ts).
 */
const SELF_REPEATING = new Set(["chat.open", "palette.open"])
/** A deliberate repeat uses the receipt; it never spends another live operation. */
export const completedGuideAction = (action: GuideAction, guide: GuideState): boolean => {
  if (SELF_REPEATING.has(action.flow)) return false
  const lesson = GUIDE_STAGES[guide.step]
  return lesson?.kind === "do" && guide.completed?.includes(lesson.completion) === true
    && lesson.actions.some(primary => primary.flow === action.flow && primary.args === action.args)
}

export interface GuideClock {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}
export const guideClock: GuideClock = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}
export const readPause = (text: string, reducedMotion = false): number =>
  reducedMotion ? 0 : Math.min(3000, 600 + 25 * text.trim().split(/\s+/).length)

/** A DOM subscription owned by the mounted shell ref; cleanup cancels stale timers. */
export function scheduleGuideAdvance({
  target, clock = guideClock, delay, paused, advance, cancel,
}: {
  target: EventTarget; clock?: GuideClock; delay: number; paused: boolean
  advance: () => void; cancel: () => void
}): () => void {
  if (paused) return () => {}
  let pending = true
  const handle = clock.setTimeout(() => {
    if (!pending) return
    pending = false
    advance()
  }, delay)
  const input = () => {
    if (!pending) return
    pending = false
    clock.clearTimeout(handle)
    cancel()
  }
  const events = ["pointerdown", "click", "keydown", "input"]
  for (const event of events) target.addEventListener(event, input, true)
  return () => {
    pending = false
    clock.clearTimeout(handle)
    for (const event of events) target.removeEventListener(event, input, true)
  }
}
