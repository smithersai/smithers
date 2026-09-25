/**
 * A coding request that works on the repository's mythical stack.
 *
 * The stack service retains the stack tip into this workspace's source ref
 * and names it as the request's `base`. Before gathering, the request imports
 * that commit and starts a fresh working change on it, so the planner's
 * native history IS the stack: a plan can amend or insert anywhere in it, or
 * append. When the request is delivered, `coding/vibe` hands the cleaned
 * result back to the stack service instead of landing it (vibe-landing.ts).
 */
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect } from "effect"
import { NativeCoding, NativeCodingError, requestIdFor } from "./native.ts"
import { CodingError, Revision, StackBase } from "./schema.ts"

export { StackBase } from "./schema.ts"

/** Positions the workspace on a fresh working change on the stack tip. */
export const AdmitStackBase = Action.make("coding/admit-stack-base", {
  payload: { base: StackBase }, success: Revision, error: CodingError, nondeterministic: true
})

const refused = (message: string) => new CodingError({ code: "source_refused", message })
const toRevision = (value: { readonly kind: string, readonly changeId: string, readonly commitId: string, readonly operationId: string,
  readonly parentCommitIds: ReadonlyArray<string>, readonly treeId?: string }): Revision | undefined =>
  value.kind === "resolved" && value.treeId !== undefined ? { changeId: value.changeId, commitId: value.commitId, treeId: value.treeId,
    operationId: value.operationId, parentCommitIds: [...value.parentCommitIds] } : undefined

/**
 * Imports the retained stack tip and creates an empty working change on it.
 * Replaying after a crash is safe: a workspace already on a fresh change on
 * the tip answers that change, and both native operations carry request ids
 * derived from this execution.
 */
export const admitStackBase = (base: StackBase, executionId: string) => Effect.gen(function*() {
  const native = yield* NativeCoding
  const before = yield* native.read()
  const head = before.head
  if (head.kind === "resolved" && head.empty === true && head.parentCommitIds.length === 1 &&
      head.parentCommitIds[0] === base.commitId && (head.description ?? "").trim() === "") {
    return toRevision(head)!
  }
  if (!native.importSource) return yield* refused("This workspace's native helper cannot import the stack tip; upgrade the workspace")
  const imported = yield* native.importSource({ requestId: requestIdFor(executionId, "stack-base/import"),
    commits: [{ commitId: base.commitId, ref: base.ref }] })
  const target = imported.revisions.find(revision => revision.commitId === base.commitId)
  if (target === undefined || target.kind !== "resolved") return yield* refused("The stack tip was not imported as a resolved commit")
  const created = yield* native.apply({ operation: "create", requestId: requestIdFor(executionId, "stack-base/create"),
    expectedOperationId: imported.operationId, target: { ...target, kind: "resolved" }, description: "" })
  const revision = created.status === "accepted" ? toRevision(created.head) : undefined
  if (revision === undefined || revision.parentCommitIds.length !== 1 || revision.parentCommitIds[0] !== base.commitId) {
    return yield* refused("The working change was not created on the stack tip")
  }
  return revision
}).pipe(Effect.mapError(error => error instanceof CodingError ? error : new CodingError({
  code: error instanceof NativeCodingError && (error.code === "source_missing" || error.code === "source_changed") ? error.code : "source_unavailable",
  message: "The stack tip could not be admitted: " + error.message
})))

export const stackBaseLayer = AdmitStackBase.toLayer(({ base }) => Effect.gen(function*() {
  const instance = yield* FlowRuntime.FlowInstance
  return yield* admitStackBase(base, instance.executionId)
}))
