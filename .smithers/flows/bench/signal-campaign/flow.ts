/**
 * `bench/signal-campaign`: refuse a scheduled signal campaign without complete
 * replayable evidence.
 *
 * Every derived case of the seeded campaign must have passed with its full
 * history, final state and at least one reopen.
 *
 * ```sh
 * smthrs flow start bench/signal-campaign --data '{"directory":"reliability-artifacts"}' --wait
 * ```
 *
 * Environment: `SMITHERS_FUZZ_SEED`, `SMITHERS_FUZZ_CASES` and
 * `SMITHERS_FUZZ_STEPS`, the campaign's configuration.
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The directory holding the campaign's `signal-inbox-<seed>.json` artifacts.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  directory: Schema.NonEmptyString
})

const implementationVersion = "bench/signal-campaign/v1"

/**
 * Runs `check-signal-campaign.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Verify = Action.make("bench/signal-campaign/verify", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `check-signal-campaign.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [request.directory]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Verify.toLayer(
  (request) => runModule(new URL("./check-signal-campaign.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("bench/signal-campaign", {
  description: "Verify every case of a seeded signal state-machine campaign passed with complete evidence.",
  capabilities: ["fs:read:**", "proc:spawn:node *"],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Verify.call(request))
})
