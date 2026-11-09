/**
 * `bench/jj-abi-campaign`: the generated native and real WASM ABI corpus.
 *
 * `run` executes the parser, native and WASM tiers over one seeded corpus,
 * bypassing build-result reuse, and refuses to overwrite earlier evidence.
 * `verify-parser` runs no tier: it checks the parser report another run, the
 * AddressSanitizer replay, wrote under the same configuration.
 *
 * ```sh
 * smthrs flow start bench/jj-abi-campaign --data '{"seed":20260904}' --wait
 * smthrs flow start bench/jj-abi-campaign --data '{"phase":"verify-parser"}' --wait
 * ```
 *
 * Environment: `SMITHERS_ABI_SEED` (when no `seed` is given),
 * `SMITHERS_ABI_CASES`, `SMITHERS_ABI_STEPS` and `SMITHERS_ABI_ARTIFACT_DIR`.
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * Which operation to run, and the seed to replay in place of `SMITHERS_ABI_SEED`.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  phase: Schema.optionalKey(Schema.Literals(["run", "verify-parser"])),
  seed: Schema.optionalKey(Schema.Number.check(Schema.isUint32()))
})

const implementationVersion = "bench/jj-abi-campaign/v1"

/**
 * Runs `run-jj-abi-campaign.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Campaign = Action.make("bench/jj-abi-campaign/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `run-jj-abi-campaign.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [
  ...(request.phase === "verify-parser" ? ["--verify-parser"] : []),
  ...(request.seed === undefined ? [] : ["--seed", String(request.seed)])
]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Campaign.toLayer(
  (request) => runModule(new URL("./run-jj-abi-campaign.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("bench/jj-abi-campaign", {
  description: "Run the seeded parser, native and WASM jj ABI campaign, or verify its sanitizer replay.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:node *", "proc:spawn:cargo *", "proc:spawn:pnpm *"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Campaign.call(request))
})
