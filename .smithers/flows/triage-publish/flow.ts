/**
 * `triage-publish`: the GitHub half of issue and pull request triage.
 *
 * `prepare` reads the GitHub event and writes `.triage/context.json` for the
 * `issue-triage` or `pr-triage` flow, which holds no GitHub credential.
 * `apply` validates the report that flow wrote and publishes its labels and
 * one comment, bound to the event's own number. The token stays in this step.
 *
 * ```sh
 * smthrs flow start triage-publish --data '{"phase":"prepare","kind":"issue"}' --wait
 * smthrs flow start triage-publish --data '{"phase":"apply","kind":"pr","number":42}' --wait
 * ```
 *
 * Environment: `GH_TOKEN`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, and
 * `TRIAGE_BOT_LOGIN` when the token is not the workflow's `GITHUB_TOKEN`.
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../automation/run-module.ts"

const Kind = Schema.Literals(["issue", "pr"])

/**
 * Which half to run. `apply` needs the number the caller read from the event;
 * the module refuses an `apply` without one.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  phase: Schema.Literals(["prepare", "apply"]),
  kind: Kind,
  number: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})

const implementationVersion = "triage-publish/v1"

/**
 * Runs `github-triage.mjs` for one phase.
 *
 * @since 1.0.0
 * @category actions
 */
export const Publish = Action.make("triage-publish/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `github-triage.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> =>
  request.phase === "prepare" || request.number === undefined
    ? [request.phase, request.kind]
    : [request.phase, request.kind, String(request.number)]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Publish.toLayer(
  (request) => runModule(new URL("./github-triage.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("triage-publish", {
  description: "Prepare a GitHub issue or pull request for triage, or publish the triage report's labels and comment.",
  capabilities: [
    "fs:read:**",
    "fs:write:.triage/**",
    "proc:spawn:node *",
    "net:get:api.github.com/**",
    "net:post:api.github.com/**"
  ],
  effects: {
    reads: [".triage/**"],
    writes: [".triage/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Publish.call(request))
})
