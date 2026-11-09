/**
 * `bench/rebase-cache`: does a rebased stack replay every target whose inputs
 * did not change?
 *
 * A manual measurement, not a gate: it builds a stack on `base`, inserts a
 * change below it, exports and plans each revision, and fails on a key that
 * moved while its inputs did not, or stayed while they moved. Method and
 * results: `.smithers/flows/bench/README.md` ("Rebase cache reuse").
 *
 * ```sh
 * smthrs flow start bench/rebase-cache --data '{"out":"/tmp/rebase-inside","insert":"packages/smithers/notifications"}' --wait
 * ```
 *
 * @since 1.0.0
 */
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
import { ModuleFailed, runModule } from "../../automation/run-module.ts"

const Labels = Schema.Array(Schema.NonEmptyString)

/**
 * The benchmark's options; each defaults as `rebase-cache.mjs` does.
 *
 * @since 1.0.0
 * @category models
 */
export const Request = Schema.Struct({
  /** A fresh result directory. */
  out: Schema.NonEmptyString,
  repo: Schema.optionalKey(Schema.NonEmptyString),
  base: Schema.optionalKey(Schema.NonEmptyString),
  /** One stacked change per package directory. */
  stack: Schema.optionalKey(Labels),
  insert: Schema.optionalKey(Schema.NonEmptyString),
  verb: Schema.optionalKey(Schema.NonEmptyString),
  pattern: Schema.optionalKey(Schema.NonEmptyString),
  install: Schema.optionalKey(Schema.NonEmptyString),
  /** Labels to run for real through the check cache. */
  execute: Schema.optionalKey(Labels),
  /** Executed labels whose failure does not fail the run. */
  allowFailed: Schema.optionalKey(Labels)
})

const implementationVersion = "bench/rebase-cache/v1"

/**
 * Runs `rebase-cache.mjs`.
 *
 * @since 1.0.0
 * @category actions
 */
export const Measure = Action.make("bench/rebase-cache/run", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  nondeterministic: true
})

/**
 * The argument array `rebase-cache.mjs` reads for a request.
 *
 * @since 1.0.0
 * @category utils
 */
export const argv = (request: typeof Request.Type): ReadonlyArray<string> => {
  const option = (name: string, value: string | ReadonlyArray<string> | undefined) =>
    value === undefined ? [] : [`--${name}`, typeof value === "string" ? value : value.join(",")]
  return [
    ...option("out", request.out),
    ...option("repo", request.repo),
    ...option("base", request.base),
    ...option("stack", request.stack),
    ...option("insert", request.insert),
    ...option("verb", request.verb),
    ...option("pattern", request.pattern),
    ...option("install", request.install),
    ...option("execute", request.execute),
    ...option("allow-failed", request.allowFailed)
  ]
}

/**
 * @since 1.0.0
 * @category layers
 */
export const layer = Measure.toLayer(
  (request) => runModule(new URL("./rebase-cache.mjs", import.meta.url), argv(request)),
  { implementationVersion }
)

export default Flow.make("bench/rebase-cache", {
  description: "Measure whether a rebased stack replays every target whose declared inputs did not change.",
  capabilities: ["fs:read:**", "fs:write:**", "proc:spawn:node *", "proc:spawn:git *", "proc:spawn:pnpm *"],
  effects: { reads: ["**"], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: ModuleFailed,
  body: Node.capture({ implementationVersion }, (request) => Measure.call(request))
})
