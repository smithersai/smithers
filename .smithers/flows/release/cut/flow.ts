/**
 * `release/cut`: cut a release on `main`.
 *
 * Writes the version and the changelog section, refreshes the lockfiles and the
 * generated documentation, verifies all of it, and prints the commit and tag
 * commands. `commit` also commits and tags locally; nothing is pushed.
 * `allowBranch` permits a cut off `main`.
 *
 * ```sh
 * smthrs flow start release/cut --data '{"version":"1.0.0"}' --wait
 * smthrs flow start release/cut --data '{"version":"1.0.0","commit":true}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The version to cut, and whether to commit and tag it locally.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  version: Schema.NonEmptyString,
  commit: Schema.optionalKey(Schema.Boolean),
  allowBranch: Schema.optionalKey(Schema.Boolean)
})

const implementationVersion = "release/cut/v1"

/**
 * Runs `cut-release.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Cut = Action.make("release/cut/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `cut-release.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [
  request.version,
  ...(request.commit === true ? ["--commit"] : []),
  ...(request.allowBranch === true ? ["--allow-branch"] : [])
]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Cut.toLayer(
  (request) => runModule(new URL("../cut-release.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/cut", {
  description:
    "Cut a release: write and verify its version, changelog and generated files, and optionally commit and tag it locally.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:git *",
    "proc:spawn:pnpm *",
    "proc:spawn:bun *",
    "net:get:registry.npmjs.org/**"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Cut.call(request))
})
