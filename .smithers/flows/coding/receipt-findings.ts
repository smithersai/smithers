/**
 * The plain policy of a completed check's receipt: which findings it supplies
 * for a planned Change. Plain TypeScript because it refuses by throwing;
 * workflow.vibe re-exports it and runs it under `Effect.try`.
 */
import { type Check, CodingError, type Implementation, type Plan, type Receipt, receiptMatches, receiptOutage } from "./schema.ts"

/**
 * Validate a completed check before either early feedback or final assessment.
 * @throws {CodingError} when the receipt is not the exact receipt of the implemented revision, a finding names an
 * invalid owner or source revision, or the check could not measure the revision (an outage)
 */
export const receiptFindings = (
  plan: Plan,
  index: number,
  implementation: Implementation,
  check: Check,
  receipt: Receipt
) => {
  const group = plan.changes[index]
  if (
    !group || group.id !== implementation.change ||
    !group.checks.some((value) =>
      value.id === check.id && value.flow === check.flow && value.flowDigest === check.flowDigest &&
      value.target === check.target && value.tier === check.tier && value.required === check.required
    ) ||
    !receiptMatches(implementation, check, receipt)
  ) {
    throw new CodingError({
      code: "invalid_receipt",
      message: `${implementation.change}: ${check.id} has no exact receipt for the implemented revision`
    })
  }
  for (const finding of receipt.findings) {
    const owner = plan.changes.findIndex((change) => change.id === finding.owner)
    if (owner < 0 || owner > index || finding.sourceCommitId !== implementation.head.commitId) {
      throw new CodingError({
        code: "invalid_receipt",
        message: `${check.id} supplied a finding with invalid owner or source revision`
      })
    }
  }
  const outage = receiptOutage(receipt)
  if (outage) throw outage
  return check.required && receipt.status !== "passed" && receipt.findings.length === 0
    ? [{ owner: group.id, sourceCommitId: implementation.head.commitId, message: `${check.id}: ${receipt.status}` }]
    : receipt.findings
}
