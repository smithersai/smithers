import { MODEL_TIERS } from "../model/contract"
import { checkSave, type Refusal, type SavedConnection, TIER_FIELDS } from "./contract"
import { defaultsFrom, type SaveForm } from "./view"

/**
 * Why `draft`, the list on screen, can't be tested: what Save would refuse, `unsaved` unless it is the saved list, in
 * its order, field by field; else nothing. Keys stay in this synchronous check; only a saved connection's id may enter
 * model/test.
 */
export const testDraftProblem = (draft: SaveForm, saved: ReadonlyArray<SavedConnection>): Refusal | "unsaved" | undefined => {
  const checked = checkSave(draft, saved, undefined, defaultsFrom(saved))
  if (typeof checked === "string") return checked
  if (checked.connections.length !== saved.length) return "unsaved"
  for (const [index, connection] of checked.connections.entries()) {
    if (connection.key !== undefined) return "unsaved"
    const row = saved[index]!
    if (row.id !== connection.id || row.active !== connection.active) return "unsaved"
    for (const tier of MODEL_TIERS) {
      if (row[TIER_FIELDS[tier]] !== (connection.models[tier] ?? null)) return "unsaved"
    }
  }
  return undefined
}
