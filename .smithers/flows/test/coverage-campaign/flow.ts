/** Retained-scope inventory and source-bound evidence inspection for #2290. */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.vibe"

/** @since 1.0.0 */
export const Request = Schema.Struct({ mode: Schema.Literals(["snapshot", "status", "gate"]) })
const implementationVersion = "test/coverage-campaign/v1"
/** @since 1.0.0 */
export const Inspect = Action.make("test/coverage-campaign/inspect", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})
/** @since 1.0.0 */
export const layer = Inspect.toLayer(
  (request) => runModule(new URL("./main.mjs", import.meta.url), [request.mode]),
  { implementationVersion }
)
export default Flow.make("test/coverage-campaign", {
  description: "Inventory retained packages and inspect reproducible test receipts; refuse incomplete qualification.",
  capabilities: [
    "fs:read:**",
    "fs:write:.smithers/flows/test/coverage-campaign/**",
    "proc:spawn:node *",
    "proc:spawn:jj *"
  ],
  effects: {
    reads: ["**"],
    writes: [".smithers/flows/test/coverage-campaign/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Inspect.call(request))
})
