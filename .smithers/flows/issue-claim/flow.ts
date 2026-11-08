/**
 * `issue-claim`: claim an issue before working it, and release it after.
 *
 * Runs `issue-claim.mjs`, the shared convention every agent, session, machine
 * and Cloud worker follows (AGENTS.md): the `in-progress` label plus a
 * `Claimed by <who> on <host> at <UTC>; expires <UTC+6h>` comment, written
 * through the machine's GitHub proxy (`github-proxy.mjs`) so every write on the
 * machine shares one rate limiter.
 *
 * ```sh
 * smthrs flow start issue-claim --data '{"command":"claim","issue":"smithersai/smithers#1","by":"agent/session"}' --wait
 * ```
 *
 * `pnpm issue-claim <command> <repo>#<n> [flags]` runs the same module
 * directly as `node .smithers/flows/issue-claim/issue-claim.mjs`. That is the bootstrap
 * path: claims keep working while `smthrs` on `main` is broken, so the module
 * keeps its own command line and needs only Node and `gh`.
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../automation/run-module.vibe"

/**
 * `issue-claim.mjs`'s command line. The module, not this schema, refuses an
 * invalid combination, such as `--close` without a receipt or a reason.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  command: Schema.Literals(["check", "claim", "release", "comment"]),
  /** `<repo>#<n>` or `<owner>/<repo>#<n>`. */
  issue: Schema.NonEmptyString,
  by: Schema.optionalKey(Schema.NonEmptyString),
  note: Schema.optionalKey(Schema.NonEmptyString),
  force: Schema.optionalKey(Schema.Boolean),
  body: Schema.optionalKey(Schema.NonEmptyString),
  bodyFile: Schema.optionalKey(Schema.NonEmptyString),
  close: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(Schema.NonEmptyString),
  landed: Schema.optionalKey(Schema.NonEmptyString),
  receipts: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  release: Schema.optionalKey(Schema.Boolean),
  pr: Schema.optionalKey(Schema.Boolean)
})

const implementationVersion = "issue-claim/v1"

/**
 * Runs `issue-claim.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const IssueClaim = Action.make("issue-claim/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `issue-claim.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [
  request.command,
  request.issue,
  ...(request.by === undefined ? [] : ["--by", request.by]),
  ...(request.note === undefined ? [] : ["--note", request.note]),
  ...(request.force === true ? ["--force"] : []),
  ...(request.body === undefined ? [] : ["--body", request.body]),
  ...(request.bodyFile === undefined ? [] : ["--body-file", request.bodyFile]),
  ...(request.close === true ? ["--close"] : []),
  ...(request.reason === undefined ? [] : ["--reason", request.reason]),
  ...(request.landed === undefined ? [] : ["--landed", request.landed]),
  ...(request.receipts ?? []).flatMap((path) => ["--receipt", path]),
  ...(request.release === true ? ["--release"] : []),
  ...(request.pr === true ? ["--pr"] : [])
]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = IssueClaim.toLayer(
  (request) => runModule(new URL("./issue-claim.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("issue-claim", {
  description: "Claim, check, release or comment on an issue through the machine's GitHub proxy.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:gh *",
    "proc:spawn:git *",
    "net:get:**",
    "net:post:**"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => IssueClaim.call(request))
})
