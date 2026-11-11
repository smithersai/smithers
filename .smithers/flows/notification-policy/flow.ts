/**
 * `notification-policy`: the repository-owned answer to who is told about a
 * repository notice (M-47, `.specs/product/mvp.md` §6.17,
 * [#4026](https://github.com/smithersai/smithers/issues/4026)).
 *
 * A notification host binds this flow — or a repository's own copy of it —
 * for one repository with `RecipientPolicy.layerFlow(repoId, flow)` from
 * `apps/mvp/worker/NotificationPolicy.ts`. The app then runs it through its
 * durable engine for each run notice and each `main` or release event of that
 * repository, and tells the recipients it names. It reads nothing, writes
 * nothing, spawns nothing and calls no model: a routing decision is a
 * declaration the repository owns, and keeping it pure is what makes it safe
 * to run on every notice.
 *
 * Safety contract, in one line each:
 * - identity in, recipient ids out — no title, prompt, body, diff or secret
 *   crosses either way, so no notification or diagnostic can carry one;
 * - the app checks access again afterwards, so naming someone who cannot read
 *   the work withholds them and grants nothing;
 * - a failure here is not silence: the app falls back to its built-in
 *   audience and counts one closed reason.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { Decide, Decision, implementationVersion, Request } from "./src/policy.ts"

export { layer } from "./src/policy.ts"

export default Flow.make("notification-policy", {
  description: "Decide who is told about a repository notification, among the people who can already read it.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "lane", tier: "sealed" },
  /* A notification's audience is the repository's declared rule, never a model's guess. */
  modelInvocable: false,
  payload: Request,
  success: Decision,
  error: Schema.Never,
  /* A captured body has a stable identity, so the durable engine can drive and replay it. */
  body: Node.capture({ implementationVersion }, (input) => Decide.call(input))
})
