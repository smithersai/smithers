import { MODEL_TIERS } from "../model/contract"
import { checkSave, type Refusal, type SavedKey, TIER_FIELDS } from "./contract"
import type { SaveForm } from "./view"

/** Keys stay in this synchronous check; only the saved configuration may enter model/test. */
export const testDraftProblem = (draft: SaveForm, saved: ReadonlyArray<SavedKey>): Refusal | "unsaved" | undefined => {
  const checked = checkSave(draft, saved)
  if (typeof checked === "string") return checked
  if (checked.keys.length !== saved.length) return "unsaved"
  for (const key of checked.keys) {
    if (key.key !== undefined) return "unsaved"
    // checkSave proved a blank key retains a saved key at this exact URL.
    const row = saved.find((each) => each.protocol === key.protocol)!
    for (const tier of MODEL_TIERS) {
      const choice = checked.models[tier]
      if (row[TIER_FIELDS[tier]] !== (choice?.protocol === key.protocol ? choice.modelId : null)) return "unsaved"
    }
  }
  return undefined
}
