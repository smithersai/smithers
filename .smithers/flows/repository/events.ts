/** Signed event payloads name source; a workspace tip cannot substitute for it. */
import * as Payload from "@smthrs/integrations/github/Payload"
import { Result } from "effect"
import { CodingError } from "../coding/schema.ts"
import type { Event } from "./schema.ts"
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
/** What the job tells a person about a push the host's one admission refuses. */
const refusals: { readonly [Refusal in Payload.PushRefusal]: string } = {
  malformed: "The GitHub push must name its exact ref and before/after commits",
  deleted_identity: "The deleted ref has an invalid GitHub push identity",
  no_candidate: "The GitHub push has no valid candidate or creation identity"
}
export const sourceEvent = (event: typeof Event.Type) => {
  if (event.source !== "github" || event.type !== "push") return { ignored: false, payload: event.payload }
  if (event.action !== "" && event.action !== "pushed") throw invalid("GitHub push events do not have that action")
  const source = Payload.pushSource(event.payload)
  if (Result.isFailure(source)) throw invalid(refusals[source.failure])
  if (source.success.kind === "deleted") return { ignored: true, payload: event.payload }
  return {
    ignored: false,
    sourceRevision: source.success.after,
    payload: {
      ...object(event.payload),
      candidateCommitId: source.success.after,
      baseCommitId: source.success.before
    } as typeof Event.Type["payload"]
  }
}
