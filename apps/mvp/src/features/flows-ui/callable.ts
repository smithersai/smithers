import { entryOf, type FlowName, names } from "../../flows/registry.vibe"
import { FORBIDDEN_CALLS } from "./contract"
import type { CatalogEntry } from "./instructions"

// What a person's flow may call (decision 0014 §2, "Calls"): the app flows the agent may call, which are the registry's
// entries with no `userOnlyReason` (src/flows/registry.test.ts holds the two together), minus the authoring and run
// acts, which a person's flow never calls. The drafting agent is shown these, the checks admit only these, and a run's
// catalog is these intersected with its own list (src/flows/catalog.ts).

/** Whether `flow` is an authoring or run act. */
export const forbidden = (flow: string): boolean => FORBIDDEN_CALLS.some((prefix) => flow.startsWith(prefix))

/** The app flows a person's flow may name in `flows:`, in the registry's order. */
export const PROMPT_CALLABLE: ReadonlyArray<FlowName> = names.filter((name) =>
  entryOf(name).userOnlyReason === undefined && !forbidden(name)
)

/**
 * The same flows with each one's description, as the drafting agent reads them. Every flow the agent may call is a
 * declaration, which carries its description (src/flows/catalog.test.ts holds it).
 */
export const PROMPT_CATALOG: ReadonlyArray<CatalogEntry> = PROMPT_CALLABLE.map((name) => ({
  name,
  description: entryOf(name).flow.description!,
}))
