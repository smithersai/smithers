/**
 * The plain planning policy: how a model's draft is bound to the host-measured
 * facts. Plain TypeScript because `finalize` refuses by throwing; planning.vibe
 * re-exports it and runs it under `Effect.try`.
 */
import { emptyWorkingChange, sameCode } from "./planning.vibe"
import { projectMemory } from "./project-memory.ts"
import { CodingError, type Plan, type PlanningInput, validatePlan } from "./schema.ts"
import type { Draft, PlanningContext } from "./planning.vibe"

const invalid = (message: string) => new CodingError({ code: "invalid_plan", message })

const filePath = (value: string) =>
  value.length > 0 && value.length <= 4096 && !/[\\\0]/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !/^\.(git|jj)$/i.test(part))

/**
 * @throws {CodingError} `invalid_plan` when the draft does not bind to the gathered history, checks and paths
 */
export const finalize = (input: typeof PlanningInput.Type, context: PlanningContext, draft: Draft): Plan => {
  const nativeIds = new Set<string>()
  for (const [index, atom] of context.history.entries()) {
    if (
      nativeIds.has(atom.changeId) || atom.parentCommitIds.length !== 1 ||
      (index > 0 && atom.parentCommitIds[0] !== context.history[index - 1]!.commitId)
    ) {
      throw invalid("Planning history is not a unique resolved linear native chain")
    }
    nativeIds.add(atom.changeId)
  }
  if (!sameCode(context.history.at(-1)!, context.head)) {
    throw invalid("Planning history does not end at its captured head")
  }
  let baseIndex = context.history.findIndex((atom) => atom.changeId === draft.baseChangeId)
  if (baseIndex < 0) {
    throw invalid("The proposed base is outside the gathered native history; gather its missing context first")
  }
  const remaining = context.history.slice(baseIndex + 1).map((atom) => atom.changeId)
  const working = emptyWorkingChange(context.history)
  const listed = draft.changes.some((change) => change.atoms.some((atom) => atom.changeId === working))
  if (working !== undefined && remaining.at(-1) === working && !listed) {
    // The empty working change holds no code, so a plan need not keep it. A
    // model bases an append on the tip's commit below it (the 2026-10-05
    // walk); that append moves onto the working change, the plan a model
    // basing it on the head makes.
    remaining.pop()
    if (baseIndex === context.history.length - 2) baseIndex++
  }
  const actual: Array<string> = []
  const checks = new Map(context.checks.map((check) => [check.id, check]))
  if (checks.size !== context.checks.length) throw invalid("Configured planning checks have duplicate IDs")
  const changes = draft.changes.map((change) => {
    for (const atom of change.atoms) {
      if (![...atom.reads, ...atom.writes].every(filePath)) {
        throw invalid("Predicted files must be normalized repository-relative paths outside native metadata")
      }
      // New atoms may sit anywhere after the base: the native adapter creates
      // them with `jj new --insert-after`, and JJ restacks the descendants.
      if (atom.changeId !== null) actual.push(atom.changeId)
    }
    return {
      ...change,
      // The edit leaf receives the atom, not the full Plan. Preserve the user's
      // acceptance criteria even when the planner reduces its intent to "edit".
      atoms: change.atoms.map((atom) => ({
        ...atom,
        intent: JSON.stringify({
          request: input.prompt,
          feedback: input.feedback,
          ...(input.answers?.length ? { answers: input.answers } : {}),
          change: change.intent,
          atom: atom.intent
        })
      })),
      implementation: context.implementation,
      implementationDigest: context.implementationDigest,
      checks: [
        ...change.checks.map((id) => {
          const check = checks.get(id)
          if (!check) throw invalid(`The planner selected an unavailable check: ${id}`)
          return check
        }),
        ...context.checks.filter((check) => check.required && !change.checks.includes(check.id))
      ]
    }
  })
  if (JSON.stringify(actual) !== JSON.stringify(remaining)) {
    throw invalid(
      "The plan must retain every existing descendant in native order so its checks are invalidated and rerun"
    )
  }
  const memory = projectMemory(context)
  const plan: Plan = {
    prompt: input.prompt,
    memoryRevision: context.memoryRevision,
    ...(context.wikiCitations === undefined ? {} : { wikiCitations: context.wikiCitations }),
    ...(memory.length === 0 ? {} : { memory }),
    base: context.history[baseIndex]!,
    observedHead: context.head,
    changes
  }
  validatePlan(plan)
  return plan
}
