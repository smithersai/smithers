/**
 * The reasoning effort a flow's frontmatter declares.
 *
 * @since 1.0.0-rc.17
 */

import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Schema from "effect/Schema"

/**
 * The flow's `effort:` frontmatter, or `undefined` when it declares none.
 *
 * The value is checked against the effort vocabulary, and an unrecognised
 * spelling reads as no declaration rather than failing the launch: effort is a
 * tuning knob, not a contract.
 *
 * @category projections
 * @since 1.0.0-rc.17
 */
export const declaredEffort = (
  descriptor: { readonly frontmatter: Readonly<Record<string, unknown>> }
): ModelRequest.ReasoningEffort | undefined => {
  const declared = descriptor.frontmatter["effort"]
  return typeof declared === "string" && Schema.is(ModelRequest.ReasoningEffort)(declared) ? declared : undefined
}
