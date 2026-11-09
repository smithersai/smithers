/**
 * `release/version`: set every versioned manifest and source to one release
 * version, or with `check` verify they already carry it.
 *
 * ```sh
 * smthrs flow start release/version --data '{"version":"1.0.0"}' --wait
 * smthrs flow start release/version --data '{"version":"1.0.0","check":true}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The release version, and whether to verify rather than write it.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  version: Schema.NonEmptyString,
  check: Schema.optionalKey(Schema.Boolean)
})

const implementationVersion = "release/version/v1"

/**
 * Runs `set-release-version.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const SetVersion = Action.make("release/version/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `set-release-version.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> =>
  request.check === true ? ["--check", request.version] : [request.version]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = SetVersion.toLayer(
  (request) => runModule(new URL("../set-release-version.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/version", {
  description: "Set every versioned manifest and source to one release version, or verify they carry it.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => SetVersion.call(request))
})
