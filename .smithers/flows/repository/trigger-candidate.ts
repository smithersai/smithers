/** The digest a schedule registration is identified by: plain TypeScript, so `recoverTriggerRequest` reads it synchronously. */
import * as Digest from "@smthrs/core/Digest"
import type { TriggerRequest } from "./schema.vibe"

/** 64-hex over the canonical request; Plue requires ^[a-f0-9]{64}$ for `digest`. */
export const triggerCandidate = (request: TriggerRequest): string =>
  Digest.digest(
    Digest.canonical({
      repo: request.repo,
      slug: request.slug,
      flow: request.flow,
      schedule: request.schedule,
      input: request.input
    })
  )
