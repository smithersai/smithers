import * as Fault from "@smthrs/flow/Fault"
import { Schema } from "effect"

/**
 * The plan, the identity or GitHub refused the run; the message names why, never a secret.
 *
 * @since 1.0.0
 * @category errors
 */
export class FileRefused extends Schema.TaggedError<FileRefused>()("issues/file-tree/Refused", {
  code: Schema.String,
  message: Schema.String
}) {}
Fault.register("issues/file-tree/Refused", {
  unavailable: "infra",
  unavailable_exhausted: "infra",
  identity: "user", plan: "user", refused: "user", token: "user",
  invalid: "user", pending: "user", scrub: "user", search: "user", failed: "bug"
})

