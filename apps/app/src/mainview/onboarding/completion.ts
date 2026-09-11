import type { GuideState } from "../state/AppState"

export const completeGuide = (guide: GuideState, signal: string): GuideState => ({
  ...guide,
  completed: [...new Set([...(guide.completed ?? []), signal])],
  autoPaused: false,
})
