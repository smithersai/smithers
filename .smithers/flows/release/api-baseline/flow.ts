/**
 * `release/api-baseline`: compare every public package's declarations with
 * the reviewed baseline, `fixtures/public-api-baseline.json`.
 *
 * `buildDeclarations` compiles the declarations into an isolated temporary tree
 * first; without it the module reads the declarations a prior `release/build-packages`
 * left in each package. `update` records reviewed declarations instead of
 * comparing them.
 *
 * ```sh
 * smthrs flow start release/api-baseline --wait
 * smthrs flow start release/api-baseline --data '{"buildDeclarations":true,"update":true}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.vibe"

/**
 * Compare, or with `update` record, the declaration baseline.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  buildDeclarations: Schema.optionalKey(Schema.Boolean),
  update: Schema.optionalKey(Schema.Boolean)
})

const implementationVersion = "release/api-baseline/v1"

/**
 * Runs `check-api-baseline.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Check = Action.make("release/api-baseline/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `check-api-baseline.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (
  request: typeof Request.Type
): ReadonlyArray<string> => [
  ...(request.buildDeclarations === true ? ["--build-declarations"] : []),
  ...(request.update === true ? ["--update"] : [])
]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Check.toLayer(
  (request) => runModule(new URL("../check-api-baseline.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/api-baseline", {
  description:
    "Compare every public package's declarations with the reviewed API baseline, or record a reviewed update.",
  capabilities: [
    "fs:read:**",
    "fs:write:.smithers/flows/release/fixtures/public-api-baseline.json",
    "proc:spawn:node *"
  ],
  effects: {
    reads: ["**"],
    writes: [".smithers/flows/release/fixtures/public-api-baseline.json"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Check.call(request))
})
