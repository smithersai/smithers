/**
 * `notification-policy`: the repository-owned answer to who is told about a
 * repository notice (M-47, `.specs/product/mvp.md` §6.17,
 * [#4026](https://github.com/smithersai/smithers/issues/4026)).
 *
 * A repository claims notification policy by naming this flow — or its own
 * copy of it — on the Dispatcher event the app asks on, in
 * `.smithers/FACTORY.ts`:
 *
 * ```ts
 * on: { "notification.route": { flow: "notification-policy", description: "Choose who is told" } }
 * ```
 *
 * The app then runs this flow through the ordinary workflow path for each
 * notice in the defined set and tells the recipients it names. It reads
 * nothing, writes nothing, spawns nothing and calls no model: a routing
 * decision is a declaration the repository owns, and keeping it pure is what
 * makes it safe to run on every notice.
 *
 * Safety contract, in one line each:
 * - identity in, recipient ids out — no title, prompt, body, diff or secret
 *   crosses either way, so no notification or diagnostic can carry one;
 * - the app checks access again afterwards, so naming someone who cannot read
 *   the work withholds them and grants nothing;
 * - a failure here is not silence: the app falls back to its built-in
 *   audience and records one closed reason on the notice.
 */
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
import { Decide, Decision, Request } from "./src/policy.vibe"

export { layer } from "./src/policy.vibe"

export default Flow.make("notification-policy", {
  description: "Decide who is told about a repository notification, among the people who can already read it.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "lane", tier: "sealed" },
  /* A notification's audience is the repository's declared rule, never a model's guess. */
  modelInvocable: false,
  payload: Request,
  success: Decision,
  error: Schema.Never,
  body: (input) => Decide.call(input)
})
