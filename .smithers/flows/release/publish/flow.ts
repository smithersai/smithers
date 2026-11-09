/**
 * `release/publish`: publish a smoke-tested candidate's exact tarballs to npm.
 *
 * The module requires the checked-out source to be `RELEASE_TAG`, the candidate
 * to match its smoke evidence, and every tarball's integrity to match the
 * candidate; it publishes only the packages the registry lacks, in dependency
 * order, and refuses a registry integrity mismatch. The npm credential comes from
 * `NODE_AUTH_TOKEN` or trusted publishing and never enters the payload.
 *
 * ```sh
 * smthrs flow start release/publish --data '{"directory":"dist/release-packs"}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The smoke-tested candidate directory (`dist/release-packs` when omitted).
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  directory: Schema.optionalKey(Schema.NonEmptyString)
})

const implementationVersion = "release/publish/v1"

/**
 * Runs `publish-release.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Publish = Action.make("release/publish/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `publish-release.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> =>
  request.directory === undefined ? [] : [request.directory]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Publish.toLayer(
  (request) => runModule(new URL("../publish-release.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/publish", {
  description: "Publish a smoke-tested release candidate's exact tarballs to npm in dependency order.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:pnpm *",
    "proc:spawn:git *",
    "proc:spawn:sleep *",
    "net:get:registry.npmjs.org/**",
    "net:post:registry.npmjs.org/**"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Publish.call(request))
})
