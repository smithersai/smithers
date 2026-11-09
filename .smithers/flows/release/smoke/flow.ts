/**
 * `release/smoke`: install a packed candidate into scratch consumers and import
 * every published entry point, ESM and CJS.
 *
 * Resolves first-party packages only from a loopback registry over the
 * candidate's tarballs and runs no install script. On success it writes
 * `smoke-evidence.json`, bound to the candidate's integrity, into the candidate
 * directory.
 *
 * ```sh
 * smthrs flow start release/smoke --data '{"directory":"dist/release-packs"}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The packed candidate directory.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  directory: Schema.NonEmptyString
})

const implementationVersion = "release/smoke/v1"

/**
 * Runs `smoke-release.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Smoke = Action.make("release/smoke/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `smoke-release.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [request.directory]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Smoke.toLayer(
  (request) => runModule(new URL("../smoke-release.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/smoke", {
  description:
    "Install a packed release candidate into scratch consumers, import every published entry point and record smoke evidence.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:pnpm *",
    "proc:spawn:npm *",
    "proc:spawn:bun *",
    "proc:spawn:sh *",
    "proc:spawn:tar *",
    "net:get:registry.npmjs.org/**",
    "net:private:**"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Smoke.call(request))
})
