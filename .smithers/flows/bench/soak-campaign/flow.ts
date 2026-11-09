/**
 * `bench/soak-campaign`: refuse incomplete sync soak evidence.
 *
 * Scheduling a soak does not prove it ran. The verifier requires a complete
 * artifact on a supported runtime, with every post-warmup sample, useful work,
 * clean resources and growth inside budget.
 *
 * ```sh
 * smthrs flow start bench/soak-campaign --data '{"artifact":"reliability-artifacts/sync/sync-soak.json"}' --wait
 * ```
 *
 * Environment: `SMITHERS_SOAK_MINUTES`, `SMITHERS_SOAK_SEED` and
 * `SMITHERS_SOAK_NODE`, each checked against the artifact when set.
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The soak artifact to verify.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  artifact: Schema.NonEmptyString
})

const implementationVersion = "bench/soak-campaign/v1"

/**
 * Runs `check-soak-campaign.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Verify = Action.make("bench/soak-campaign/verify", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `check-soak-campaign.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [request.artifact]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Verify.toLayer(
  (request) => runModule(new URL("./check-soak-campaign.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("bench/soak-campaign", {
  description: "Verify a sync soak artifact is complete, on schedule and inside its growth budgets.",
  capabilities: ["fs:read:**", "proc:spawn:node *"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Verify.call(request))
})
