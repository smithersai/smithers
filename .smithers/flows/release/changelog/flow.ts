/**
 * `release/changelog`: write the `CHANGELOG.md` section for a release from
 * its commit range, or with `check` report drift without writing.
 *
 * `version` defaults to the `packages/smithers` version, `from` to the nearest
 * `v*` tag below `to`, and `to` to `HEAD`.
 *
 * ```sh
 * smthrs flow start release/changelog --wait
 * smthrs flow start release/changelog --data '{"check":true,"version":"1.0.0"}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The release and commit range to render, and whether to check rather than write.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  version: Schema.optionalKey(Schema.NonEmptyString),
  from: Schema.optionalKey(Schema.NonEmptyString),
  to: Schema.optionalKey(Schema.NonEmptyString),
  check: Schema.optionalKey(Schema.Boolean)
})

const implementationVersion = "release/changelog/v1"

/**
 * Runs `generate-changelog.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Changelog = Action.make("release/changelog/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `generate-changelog.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [
  ...(request.version === undefined ? [] : ["--version", request.version]),
  ...(request.from === undefined ? [] : ["--from", request.from]),
  ...(request.to === undefined ? [] : ["--to", request.to]),
  ...(request.check === true ? ["--check"] : [])
]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Changelog.toLayer(
  (request) => runModule(new URL("../generate-changelog.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/changelog", {
  description: "Write or drift-check the CHANGELOG.md section for a release from its commit range.",
  capabilities: [
    "fs:read:**",
    "fs:write:CHANGELOG.md",
    "proc:spawn:node *",
    "proc:spawn:git *"
  ],
  effects: { reads: ["**"], writes: ["CHANGELOG.md"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Changelog.call(request))
})
