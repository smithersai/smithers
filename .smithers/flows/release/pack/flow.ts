/**
 * `release/pack`: pack every published package into a candidate directory.
 *
 * Writes one tarball per package, `manifest.json` in publication order and the
 * `release-manifest.json` candidate that smoke, restore and publish verify.
 * `RELEASE_TAG` binds the candidate to its tag, and
 * `SMITHERS_NATIVE_HELPERS_DIR` supplies the native helpers. `list` prints the
 * publication order instead: workspace `directories` or package `names`.
 *
 * ```sh
 * smthrs flow start release/pack --data '{"directory":"dist/release-packs"}' --wait
 * smthrs flow start release/pack --data '{"list":"names"}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The candidate directory to pack into, or the order to `list`.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  directory: Schema.optionalKey(Schema.NonEmptyString),
  list: Schema.optionalKey(Schema.Literals(["directories", "names"]))
}).check(
  Schema.makeFilter((request) =>
    (request.directory === undefined) === (request.list === undefined)
      ? "give the candidate directory or a list, not both or neither"
      : undefined
  )
)

const implementationVersion = "release/pack/v1"

/**
 * Runs `pack-release.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Pack = Action.make("release/pack/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `pack-release.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> =>
  request.list === "directories" ? ["--list"] : request.list === "names" ? ["--names"] : [request.directory ?? ""]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Pack.toLayer(
  (request) => runModule(new URL("../pack-release.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/pack", {
  description:
    "Pack every published package into a candidate directory with its release manifest, or list the publication order.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:pnpm *",
    "proc:spawn:git *",
    "proc:spawn:jj *"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Pack.call(request))
})
