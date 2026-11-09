/**
 * `release/restore`: restore an archived release candidate from this
 * repository's Release run instead of rebuilding it.
 *
 * `checkInputs` validates the selection in `CANDIDATE_RUN_ID` and
 * `CANDIDATE_ARTIFACT_ID` and restores nothing. Otherwise the module downloads
 * the artifact with `GH_TOKEN`, verifies its run, digest and tag binding against
 * `RELEASE_TAG`, and extracts it into `directory` through a fresh staging
 * directory.
 *
 * ```sh
 * smthrs flow start release/restore --data '{"checkInputs":true}' --wait
 * smthrs flow start release/restore --data '{"directory":"dist/release-packs"}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * Validate the archived selection, or restore into `directory` (`dist/release-packs` when omitted).
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  directory: Schema.optionalKey(Schema.NonEmptyString),
  checkInputs: Schema.optionalKey(Schema.Boolean)
}).check(
  Schema.makeFilter((request) =>
    request.checkInputs === true && request.directory !== undefined
      ? "checkInputs restores nothing; give it no directory"
      : undefined
  )
)

const implementationVersion = "release/restore/v1"

/**
 * Runs `restore-release.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Restore = Action.make("release/restore/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `restore-release.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> =>
  request.checkInputs === true ? ["--check-inputs"] : request.directory === undefined ? [] : [request.directory]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Restore.toLayer(
  (request) => runModule(new URL("../restore-release.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/restore", {
  description:
    "Validate an archived release candidate selection, or restore and verify that candidate from this repository's Release run.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:gh *",
    "proc:spawn:git *",
    "proc:spawn:python3 *",
    "net:get:api.github.com/**"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Restore.call(request))
})
