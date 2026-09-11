import { Schema } from "effect"
import { Plan, validatePlan } from "../../../../../flows/coding/schema"

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/))
export const ChangeReceipt = Schema.Struct({
  runId: Schema.NonEmptyString, repo: Schema.NonEmptyString,
  base: Sha, sha: Sha, parent: Sha, subject: Schema.NonEmptyString,
  files: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1))
})
export type ChangeReceipt = typeof ChangeReceipt.Type
export const decodeChangeReceipt = Schema.decodeUnknownSync(ChangeReceipt)
export const validateTutorialPlan = (plan: Plan): Plan => {
  validatePlan(plan)
  if (plan.changes.length !== 1 || plan.changes[0]!.atoms.length !== 1) throw new Error("The tutorial change must plan exactly one commit.")
  if (!/^[a-f0-9]{40,64}$/.test(plan.base.commitId)) throw new Error("The plan needs the captured Git HEAD.")
  return plan
}
export const receiptMatchesPlan = (receipt: ChangeReceipt, plan: Plan, repo: string, runId: string): boolean =>
  receipt.repo === repo && receipt.runId === runId && receipt.base === plan.base.commitId &&
  receipt.parent === receipt.base && receipt.sha !== receipt.base && receipt.files.length > 0
