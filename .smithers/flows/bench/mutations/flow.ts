/**
 * `bench/mutations`: the behavioral mutation gate.
 *
 * Each mutant in `manifest.mjs` is applied through a Vite transform, never by
 * rewriting source; its baseline must pass and the mutant must fail the named
 * behavioral assertion. The gate refuses a nonempty evidence directory.
 *
 * ```sh
 * smthrs flow start bench/mutations --wait
 * ```
 *
 * Environment: `SMITHERS_MUTATION_ARTIFACT_DIR`, a fresh evidence directory; a
 * temporary one otherwise.
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The gate takes no arguments.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({})

const implementationVersion = "bench/mutations/v1"

/**
 * Runs `check-mutations.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Mutations = Action.make("bench/mutations/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Mutations.toLayer(
  () => runModule(new URL("./check-mutations.mjs", import.meta.url), []),
  { implementationVersion }
)

export default Flow.make("bench/mutations", {
  description: "Prove each declared mutant fails its named behavioral assertion while its baseline passes.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:node *"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Mutations.call(request))
})
