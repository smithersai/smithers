/**
 * `bench/gate`: the scheduler and journal cost gate over its production fixtures.
 *
 * The counter gate compares every fixture's validated output and SQLite
 * statement counts with `baseline.json`. `measure` adds the scheduled cold,
 * warmup and repeated warm observations; `candidate` writes a proposed baseline
 * for review instead of comparing. Methods: `.smithers/flows/bench/README.md`.
 *
 * ```sh
 * smthrs flow start bench/gate --wait
 * smthrs flow start bench/gate --data '{"measure":true,"exposeGc":true}' --wait
 * ```
 *
 * Environment: `SMITHERS_BENCH_ARTIFACT_DIR`, a fresh output directory; a
 * temporary one otherwise.
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The gate's command line: `--measure`, `--candidate`, and Node's `--expose-gc`.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  measure: Schema.optionalKey(Schema.Boolean),
  candidate: Schema.optionalKey(Schema.Boolean),
  exposeGc: Schema.optionalKey(Schema.Boolean)
})

const implementationVersion = "bench/gate/v1"

/**
 * Runs `gate.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Gate = Action.make("bench/gate/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `gate.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [
  ...(request.measure === true ? ["--measure"] : []),
  ...(request.candidate === true ? ["--candidate"] : [])
]

/**
 * The interpreter arguments for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const nodeArgs = (request: typeof Request.Type): ReadonlyArray<string> =>
  request.exposeGc === true ? ["--expose-gc"] : []

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Gate.toLayer(
  (request) => runModule(new URL("./gate.mjs", import.meta.url), argv(request), { nodeArgs: nodeArgs(request) }),
  { implementationVersion }
)

export default Flow.make("bench/gate", {
  description: "Run the scheduler and journal cost gate, or its scheduled timing observations.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:node *"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Gate.call(request))
})
