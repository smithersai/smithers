/**
 * `land`: commit the whole shared checkout to `main`, and with `push`, publish it.
 *
 * Runs `commit.mjs`. It commits every non-ignored edit, other contributors'
 * included, with jj when the checkout has it and Git otherwise. `push` needs
 * the shell commands in `tests` or a `noTest` reason, and always runs the five
 * landing drift targets before it publishes; `noTest` skips none of them. Test commands,
 * generators and gates run without database or publication credentials, and a
 * push refuses a home that holds the issue-claim credential store.
 *
 * ```sh
 * smthrs flow start land --data '{"message":"🐛 fix(app): ...","push":true,"tests":["pnpm exec smthrs test //apps/tui:unitTests"]}' --wait
 * smthrs flow start land --data '{"push":true,"noTest":"docs only"}' --wait
 * ```
 *
 * `pnpm commit [--message <m>] [--push] [--test <command> ... | --no-test <reason>]`
 * runs the same module directly as `node .smithers/flows/land/commit.mjs`. That is the
 * repair path: it lands the fix when `smthrs` on `main` is broken, so the
 * module keeps its own command line and needs only Node and Git or jj.
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../automation/run-module.vibe"

/**
 * `commit.mjs`'s command line: `--message`, `--push`, each `--test`,
 * `--no-test` and `--no-review-needed`. The module, not this schema, refuses `tests` with `noTest` and a
 * `push` with neither.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  message: Schema.optionalKey(Schema.NonEmptyString),
  push: Schema.optionalKey(Schema.Boolean),
  tests: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  noTest: Schema.optionalKey(Schema.NonEmptyString),
  noReviewNeeded: Schema.optionalKey(Schema.NonEmptyString)
})

const implementationVersion = "land/v1"

/**
 * Runs `commit.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Land = Action.make("land/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `commit.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => [
  ...(request.message === undefined ? [] : ["--message", request.message]),
  ...(request.push === true ? ["--push"] : []),
  ...(request.tests ?? []).flatMap((command) => ["--test", command]),
  ...(request.noTest === undefined ? [] : ["--no-test", request.noTest]),
  ...(request.noReviewNeeded === undefined ? [] : ["--no-review-needed", request.noReviewNeeded])
]

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Land.toLayer(
  (request) => runModule(new URL("./commit.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("land", {
  description: "Commit every edit in the shared checkout to main and, with push, publish it after the landing gates.",
  capabilities: [
    "fs:read:**",
    "fs:write:**",
    "proc:spawn:node *",
    "proc:spawn:bash *",
    "proc:spawn:git *",
    "proc:spawn:jj *",
    "proc:spawn:smthrs *",
    "net:get:**",
    "net:post:**"
  ],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Land.call(request))
})
