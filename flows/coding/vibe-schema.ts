/** Private browser-safe values projected from ordinary finalization receipts. */
import { Schema } from "effect"
import { RequestResult, Result, Revision } from "./schema.ts"

export const VibeInput = Schema.Struct({ requestExecutionId: Schema.NonEmptyString.check(Schema.isMaxLength(1024)) })
/** Original retention gates admission; cleaned retention gates append. */
export const PublicationInput = Schema.Struct({ source: Revision, phase: Schema.Literals(["original", "cleaned"]) })
export const VibeEvidence = Schema.Struct({
  requestExecutionId: VibeInput.fields.requestExecutionId,
  controlRunId: Schema.NonEmptyString,
  planId: Schema.NonEmptyString,
  planDigest: Schema.NonEmptyString,
  pocExecutionId: Schema.NonEmptyString,
  originalSource: Revision,
  request: RequestResult
})
export type VibeEvidence = typeof VibeEvidence.Type
/** Admission is permission to begin cleanup, not a landed or shipped result. */
export const VibeAdmission = Schema.Struct({ ...VibeEvidence.fields, validatedHead: Revision })
export type VibeAdmission = typeof VibeAdmission.Type
/** Descriptions and checks completed; publication and append still follow. */
export const VibeCleanup = Schema.Struct({ admission: VibeAdmission,
  summary: Schema.NonEmptyString.check(Schema.isMaxLength(16_384)), result: Result, head: Revision })
export type VibeCleanup = typeof VibeCleanup.Type
