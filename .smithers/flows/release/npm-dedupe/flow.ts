/**
 * `release/npm-dedupe`: check what an npm consumer of the published set
 * resolves: a single `effect` copy and no optional peer in the default install.
 *
 * Packs the release manifests and resolves them with npm's own arborist, so it
 * reads registry metadata. `maxPackages` bounds the resolved tree; the module
 * refuses a value that is not a positive integer. `keepTmp` keeps the scratch
 * consumers.
 *
 * ```sh
 * smthrs flow start release/npm-dedupe --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The resolved-package budget and whether to keep the scratch consumers.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  maxPackages: Schema.optionalKey(Schema.Number),
  keepTmp: Schema.optionalKey(Schema.Boolean)
})

const implementationVersion = "release/npm-dedupe/v1"

/**
 * Runs `check-npm-dedupe.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Dedupe = Action.make("release/npm-dedupe/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `check-npm-dedupe.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [
  ...(request.maxPackages === undefined ? [] : ["--max-packages", String(request.maxPackages)]),
  ...(request.keepTmp === true ? ["--keep-tmp"] : [])
]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Dedupe.toLayer(
  (request) => runModule(new URL("../check-npm-dedupe.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/npm-dedupe", {
  description: "Check that an npm consumer of the published set resolves one effect copy and no optional peer.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:npm *",
    "proc:spawn:pnpm *",
    "net:get:registry.npmjs.org/**"
  ],
  effects: { reads: ["**"], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Dedupe.call(request))
})
