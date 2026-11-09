/**
 * `release/build-packages`: build every published package from clean artifacts.
 *
 * Runs `build-release.mjs`, which removes each package's `dist` and runs its
 * `build` script in workspace dependency order. `list` prints that order and
 * builds nothing.
 *
 * ```sh
 * smthrs flow start release/build-packages --wait
 * smthrs flow start release/build-packages --data '{"list":true}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * Build everything, or `list` the build order.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  list: Schema.optionalKey(Schema.Boolean)
})

const implementationVersion = "release/build-packages/v1"

/**
 * Runs `build-release.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Build = Action.make("release/build-packages/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `build-release.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => request.list === true ? ["--list"] : []

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Build.toLayer(
  (request) => runModule(new URL("../build-release.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/build-packages", {
  description: "Build every published package from clean artifacts in workspace dependency order.",
  capabilities: [
    "fs:read:**",
    "fs:write:packages/**",
    "proc:spawn:node *",
    "proc:spawn:pnpm *"
  ],
  effects: { reads: ["**"], writes: ["packages/**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Build.call(request))
})
