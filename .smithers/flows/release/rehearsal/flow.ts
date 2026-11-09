/**
 * `release/rehearsal`: rehearse the Release workflow locally, step by step,
 * as a dispatched dry run of one tag.
 *
 * Every option mirrors the module's flag: `only` and `skip` select steps by
 * name, `node` pins setup-node toolchains (`<version>=<dir>` or a bare `<dir>`),
 * `runnerTemp` reuses an earlier run's artifacts. `publish` rehearses the
 * publishing path and still refuses unless `SMTHRS_ALLOW_PUBLISH=1` is set.
 *
 * ```sh
 * smthrs flow start release/rehearsal --data '{"tag":"v1.0.0-rc.0"}' --wait
 * smthrs flow start release/rehearsal --data '{"only":["Pack and smoke"],"keepGoing":true}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

/**
 * The module's options, one field per flag.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  tag: Schema.optionalKey(Schema.NonEmptyString),
  workflow: Schema.optionalKey(Schema.NonEmptyString),
  job: Schema.optionalKey(Schema.NonEmptyString),
  only: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  skip: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  node: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  runnerTemp: Schema.optionalKey(Schema.NonEmptyString),
  transcript: Schema.optionalKey(Schema.NonEmptyString),
  log: Schema.optionalKey(Schema.NonEmptyString),
  publish: Schema.optionalKey(Schema.Boolean),
  keepGoing: Schema.optionalKey(Schema.Boolean)
})

const implementationVersion = "release/rehearsal/v1"

/**
 * Runs `release-rehearsal.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Rehearse = Action.make("release/rehearsal/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `release-rehearsal.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [
  ...(request.tag === undefined ? [] : ["--tag", request.tag]),
  ...(request.workflow === undefined ? [] : ["--workflow", request.workflow]),
  ...(request.job === undefined ? [] : ["--job", request.job]),
  ...(request.only ?? []).flatMap((name) => ["--only", name]),
  ...(request.skip ?? []).flatMap((name) => ["--skip", name]),
  ...(request.node ?? []).flatMap((spec) => ["--node", spec]),
  ...(request.runnerTemp === undefined ? [] : ["--runner-temp", request.runnerTemp]),
  ...(request.transcript === undefined ? [] : ["--transcript", request.transcript]),
  ...(request.log === undefined ? [] : ["--log", request.log]),
  ...(request.publish === true ? ["--publish"] : []),
  ...(request.keepGoing === true ? ["--keep-going"] : [])
]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Rehearse.toLayer(
  (request) => runModule(new URL("../release-rehearsal.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("release/rehearsal", {
  description: "Rehearse the Release workflow locally as a dispatched dry run of one tag.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:bash *",
    "proc:spawn:jj *",
    "proc:spawn:git *",
    "proc:spawn:pnpm *",
    "net:get:**",
    "net:private:**"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Rehearse.call(request))
})
