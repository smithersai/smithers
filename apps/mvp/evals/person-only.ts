import { entryOf, names } from "../src/flows/registry.vibe"

/**
 * The person's own acts, from the registry (src/flows/registry.ts): every flow a person runs that the agent may not
 * (`userOnlyReason`, and not a run only a device or another flow starts), by the first sentence of its description:
 * `Accept an issue, or mark it not accepted (issue/triage)`. The agent's catalog doesn't carry them, so without this a
 * request for one reads as a request for the nearest flow it has (the agent evals' `own-triage`, 2026-10-22).
 */
export const PERSONS_OWN: string = names.flatMap((name) => {
  const { flow, userOnlyReason, acts } = entryOf(name)
  if (userOnlyReason === undefined || acts !== undefined) return []
  // Every registered flow describes itself (src/flows/registry.test.ts), though `Flow.make` leaves it optional.
  const first = flow.description!.split(/(?<=\.)\s/)[0]!.replace(/\.$/, "")
  return [`${first} (${name})`]
}).join("; ")
