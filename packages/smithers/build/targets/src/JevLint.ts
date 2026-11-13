/**
 * Judgment lint through Jev: rules a parser cannot check, asked as typed
 * yes-or-no questions about one file at a time.
 *
 * {@link LlmLint} asks a chat model to write findings. Jev, the judge behind
 * `@smthrs/model`'s `Evaluator`, answers typed questions about a JSON state
 * with a probability, so it cannot write findings and cannot run as an LlmLint
 * engine. This target asks it instead: each rule is one boolean question whose
 * "yes" means the file breaks the rule, every file a rule covers is one state,
 * and a "yes" at or above the declared threshold is a finding. Findings, the
 * report and the errors are LlmLint's own schemas, so a host renders both the
 * same way.
 *
 * @since 1.0.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import { Evaluator } from "@smthrs/model"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { escape } from "minimatch"
import * as NodePath from "node:path"
import { failureMessage } from "./GeneratedFile.ts"
import * as Input from "./Input.ts"
import {
  type Finding,
  FindingsError,
  LlmReviewError,
  maximumReviewFiles,
  redactCredentials,
  Report,
  Severity
} from "./LlmLint.ts"
import * as SafeFs from "./SafeFs.ts"
import * as Target from "./Target.ts"

/**
 * Largest file, in bytes, Jev judges. Jev reads about 32,000 tokens per
 * question set: on 2026-10-19 it took a 108,057-byte file (30,492 tokens) and
 * refused a 116,382-byte one with a 400. A larger file is never judged on part
 * of its text; it gets a `not-judged` finding instead, at the strongest severity
 * of the rules covering it, so an unjudged `error` rule fails the review and
 * the rest of the review still runs.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumJudgedFileBytes = 96 * 1024

/**
 * Most rules one declaration holds.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumRules = 256

/**
 * The probability at or above which a "yes" is a finding when a declaration
 * names none.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultThreshold = 0.8

/**
 * Files judged at once when the host names no concurrency.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultConcurrency = 8

/**
 * The deadline over one file's question, retries included, when the host names
 * none.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultTimeoutMs = 30_000

/**
 * The environment variable the default judge reads its gateway key from.
 *
 * @category constants
 * @since 1.0.0
 */
export const keyVariable = "AI_GATEWAY_API_KEY"

/**
 * A rule's id: lowercase words joined by `.` or `-`, such as
 * `durable.no-hand-rolled-retries`. It keys the rule's question and starts the
 * message of every finding the rule produces.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RuleId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
  Schema.isMaxLength(128)
)

/** Prose a rule hands the judge: nonblank and bounded. */
const ruleText = (bytes: number) => Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(bytes))

/** The fields of a rule other than the files it covers. */
const ruleFields = {
  id: RuleId,
  lookFor: ruleText(8192),
  violation: ruleText(4096),
  compliant: ruleText(4096)
}

/**
 * One rule.
 *
 * `files` are the files and globs the rule covers. `lookFor` is a yes-or-no
 * question about one file, phrased so that "yes" means the file breaks the
 * rule; `violation` says what "yes" means and `compliant` what "no" means, and
 * Jev reads both as the question's criteria. `severity` is the severity of
 * the rule's findings and defaults to `error`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Rule = Schema.Struct({
  ...ruleFields,
  files: Schema.Array(Schema.Union([Input.Glob, Input.File])).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096)
  ),
  severity: Schema.optional(Severity)
})

/**
 * One rule.
 *
 * @category models
 * @since 1.0.0
 */
export type Rule = typeof Rule.Type

/** Rule ids within one declaration name one rule each. */
const distinctIds = Schema.makeFilter(
  (rules: ReadonlyArray<{ readonly id: string }>) => {
    const seen = new Set<string>()
    for (const { id } of rules) {
      if (seen.has(id)) return `Rule id ${id} is declared more than once`
      seen.add(id)
    }
    return undefined
  },
  { identifier: "jevRuleIdsDistinct", representation: { id: "smithers-build/jevRuleIdsDistinct", payload: null } }
)

/** The probability at or above which a "yes" is a finding. */
const Threshold = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.5), Schema.isLessThanOrEqualTo(0.99))

/** The Jev model id the gateway routes to. */
const ModelId = Schema.String.check(Schema.isPattern(/^\S+$/), Schema.isMaxLength(1024))

/**
 * Attributes for {@link JevLint}.
 *
 * `rules` holds 1 to {@link maximumRules} rules with distinct ids.
 * `threshold` (0.5 to 0.99, default {@link defaultThreshold}) is the
 * probability at or above which a "yes" becomes a finding. `failOn` fails the
 * target when a finding meets that severity and defaults to `error`. `model`
 * defaults to Jev, `typesafe-ai/jev`. `manual` defaults to true, so a bare
 * wildcard lint never calls the network and naming the label runs it.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Attrs = Schema.Struct({
  rules: Schema.Array(Rule).check(Schema.isMinLength(1), Schema.isMaxLength(maximumRules), distinctIds),
  threshold: Threshold.pipe(Schema.withConstructorDefault(Effect.succeed(defaultThreshold))),
  failOn: Severity.pipe(Schema.withConstructorDefault(Effect.succeed("error" as const))),
  model: ModelId.pipe(Schema.withConstructorDefault(Effect.succeed(Evaluator.defaultModel))),
  deps: Schema.Array(Target.Target).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Target.AnyTarget>>([]))
  ),
  manual: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true)))
})

/**
 * Attributes for {@link JevLint}.
 *
 * @category models
 * @since 1.0.0
 */
export type Attrs = typeof Attrs.Type

/**
 * One rule as the review action receives it: every file is a glob and the
 * severity is resolved.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PayloadRule = Schema.Struct({
  ...ruleFields,
  files: Schema.Array(Input.Glob).check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  severity: Severity
})

/**
 * Payload for one Jev review call.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Payload = Schema.Struct({
  rules: Schema.Array(PayloadRule).check(Schema.isMinLength(1), Schema.isMaxLength(maximumRules), distinctIds),
  threshold: Threshold,
  failOn: Severity,
  model: ModelId
})

/**
 * Payload for one Jev review call.
 *
 * @category models
 * @since 1.0.0
 */
export type Payload = typeof Payload.Type

/**
 * What a Jev review fails with: a review that could not run, or one whose
 * findings met `failOn`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ReviewError = Schema.Union([LlmReviewError, FindingsError])

/**
 * What a Jev review fails with.
 *
 * @category models
 * @since 1.0.0
 */
export type ReviewError = typeof ReviewError.Type

/**
 * The one sealed action that judges every file the rules cover.
 *
 * @category actions
 * @since 1.0.0
 */
export const JevReview = Action.make("smithers-build/jev-review", {
  payload: Payload,
  success: Report,
  error: ReviewError,
  tier: "sealed"
})

/**
 * How a host runs Jev reviews.
 *
 * `judge` replaces the default judge, for example with a scripted evaluator in
 * a test or a host's own metered gateway. Without it, each review builds Jev
 * through the Vercel AI Gateway from {@link keyVariable}, so a missing key
 * fails that review and nothing else. `gatewayUrl` points the default judge at
 * another gateway endpoint. `concurrency` (default {@link defaultConcurrency})
 * bounds the files judged at once, and `timeoutMs` (default
 * {@link defaultTimeoutMs}) is the default judge's deadline per file.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReviewOptions {
  readonly workspaceRoot: string
  readonly judge?: Layer.Layer<Evaluator.Evaluator, unknown> | undefined
  readonly gatewayUrl?: string | undefined
  readonly concurrency?: number | undefined
  readonly timeoutMs?: number | undefined
}

/** Whether a finding's severity meets the failure threshold; `Severity` lists them in rising order. */
const meets = (severity: Severity, failOn: Severity): boolean =>
  Severity.literals.indexOf(severity) >= Severity.literals.indexOf(failOn)

/** The judge a review asks when the host supplies none: Jev through the gateway, keyed from the environment. */
const gatewayJudge = (
  options: ReviewOptions,
  model: string
): Effect.Effect<Layer.Layer<Evaluator.Evaluator>, LlmReviewError> =>
  Effect.suspend(() => {
    const key = process.env[keyVariable]
    if (key === undefined || key.trim() === "") {
      return Effect.fail(new LlmReviewError({ phase: "review", message: `Jev review requires ${keyVariable}` }))
    }
    return Effect.succeed(
      Evaluator.layerVercelGateway({
        apiKey: Redacted.make(key),
        model,
        timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
        ...(options.gatewayUrl === undefined ? {} : { baseUrl: options.gatewayUrl })
      }).pipe(Layer.provide(FetchHttpClient.layer))
    )
  })

/** Every file the rules cover, sorted, with the rules that cover it in declaration order. */
const select = async (
  workspaceRoot: string,
  rules: ReadonlyArray<Payload["rules"][number]>,
  signal: AbortSignal
): Promise<ReadonlyArray<{ readonly path: string; readonly rules: ReadonlyArray<Payload["rules"][number]> }>> => {
  const covered = new Map<string, Array<Payload["rules"][number]>>()
  for (const rule of rules) {
    const matched = new Set<string>()
    for (const glob of rule.files) {
      for (const path of await Input.expandGlob(workspaceRoot, "", glob, { packageScoped: false, signal })) {
        matched.add(path)
      }
    }
    // A glob that has gone stale must not read as a clean file.
    if (matched.size === 0) throw new LlmReviewError({ phase: "read", message: `Rule ${rule.id} matched no files` })
    for (const path of matched) {
      const applying = covered.get(path) ?? []
      applying.push(rule)
      covered.set(path, applying)
      if (covered.size > maximumReviewFiles) {
        throw new LlmReviewError({ phase: "read", message: `Jev review covers more than ${maximumReviewFiles} files` })
      }
    }
  }
  return [...covered.keys()].sort().map((path) => ({ path, rules: covered.get(path)! }))
}

/** One file's verdicts: a finding per rule the judge said yes to, what the question cost, and whether Jev was asked. */
interface Verdict {
  readonly findings: ReadonlyArray<Finding>
  readonly promptTokens: number
  readonly judged: boolean
}

/** Asks the judge every rule that covers one file, in one question set. */
const judgeFile = (
  root: string,
  evaluator: Evaluator.Evaluator,
  payload: Payload,
  entry: { readonly path: string; readonly rules: ReadonlyArray<Payload["rules"][number]> }
): Effect.Effect<Verdict, LlmReviewError> =>
  Effect.gen(function*() {
    // Paths and contents reach the judge, findings and diagnostics masked.
    const file = redactCredentials(entry.path)
    const contents = yield* Effect.tryPromise({
      try: (signal) =>
        SafeFs.readText(NodePath.join(root, entry.path), {
          root,
          signal,
          symlinks: "reject",
          limit: SafeFs.maximumTextBytes,
          what: "Jev review file"
        }),
      catch: (cause) => new LlmReviewError({ phase: "read", message: redactCredentials(failureMessage(cause)) })
    })
    if (contents === undefined) {
      return yield* Effect.fail(
        new LlmReviewError({ phase: "read", message: `Jev review file disappeared after discovery: ${file}` })
      )
    }
    const bytes = Buffer.byteLength(contents, "utf8")
    if (bytes > maximumJudgedFileBytes) {
      // Judging part of a file would read as a clean whole; say it was not judged, as
      // strongly as the strictest rule that went unasked.
      return {
        findings: [{
          file,
          line: 1,
          severity: entry.rules.reduce<Severity>(
            (strongest, rule) => meets(rule.severity, strongest) ? rule.severity : strongest,
            "info"
          ),
          message: `not-judged: ${bytes} bytes is over the ${maximumJudgedFileBytes}-byte file Jev reads; split the ` +
            `file or narrow ${entry.rules.map((rule) => rule.id).join(", ")}`
        }],
        promptTokens: 0,
        judged: false
      }
    }
    const questions = Object.fromEntries(entry.rules.map((rule) => [
      rule.id,
      Evaluator.BooleanQuestion.of({
        instructions: rule.lookFor,
        criteria: { true: rule.violation, false: rule.compliant }
      })
    ]))
    const response = yield* evaluator.evaluate({
      state: { path: file, contents: redactCredentials(contents) },
      questions
    }).pipe(
      Effect.mapError((error) =>
        new LlmReviewError({ phase: "review", message: `${file}: ${Evaluator.publicMessage(error)}` })
      )
    )
    const findings: Array<Finding> = []
    for (const rule of [...entry.rules].sort((left, right) => left.id < right.id ? -1 : 1)) {
      const answer = response.answers[rule.id]
      if (answer === undefined || answer.type !== "boolean") {
        return yield* Effect.fail(
          new LlmReviewError({ phase: "parse", message: `${file}: Jev gave no yes-or-no answer for ${rule.id}` })
        )
      }
      if (answer.probability >= payload.threshold) {
        findings.push({
          file,
          line: 1,
          severity: rule.severity,
          message: `${rule.id}: ${rule.violation} (Jev ${answer.probability.toFixed(2)})`
        })
      }
    }
    return { findings, promptTokens: response.usage?.inputTokens ?? 0, judged: true }
  })

/**
 * Judges every file the payload's rules cover.
 *
 * Each rule's globs expand from the workspace root, across package
 * boundaries, under the workspace's ignore rules; a rule that matches no file
 * fails the review, so a stale glob never reads as a clean file. Each covered
 * file is read whole, its path and contents masked with `redactCredentials`,
 * and judged in one call that asks every rule covering it, keyed by rule id. A
 * "yes" whose probability meets the threshold is a whole-file finding at line
 * 1, its message the rule id, the rule's `violation` and Jev's probability. A
 * file over {@link maximumJudgedFileBytes} is not sent: it gets one finding at
 * the strongest severity of the rules covering it, whose message starts
 * `not-judged:` and names its size and rules. The
 * report lists the files, the findings sorted by file and rule, and the calls
 * and input tokens spent.
 * When a finding meets `failOn` the review fails with `FindingsError`, carrying
 * every finding. A judge failure fails the review with Jev's public message,
 * never the provider's own text; a question left unanswered fails it too.
 *
 * @category execution
 * @since 1.0.0
 */
export const review = (
  options: ReviewOptions,
  untrustedPayload: Payload
): Effect.Effect<Report, LlmReviewError | FindingsError> =>
  Effect.gen(function*() {
    const payload = yield* Schema.decodeUnknownEffect(Payload)(untrustedPayload).pipe(
      Effect.mapError((error) =>
        new LlmReviewError({ phase: "review", message: `Invalid Jev review payload: ${error.message}` })
      )
    )
    const root = yield* Effect.tryPromise({
      try: () => SafeFs.canonicalRoot(options.workspaceRoot),
      catch: (cause) => new LlmReviewError({ phase: "read", message: failureMessage(cause) })
    })
    const covered = yield* Effect.tryPromise({
      try: (signal) => select(root, payload.rules, signal),
      catch: (cause) =>
        cause instanceof LlmReviewError
          ? cause
          : new LlmReviewError({ phase: "read", message: redactCredentials(failureMessage(cause)) })
    })
    const judge = options.judge ?? (yield* gatewayJudge(options, payload.model))
    const evaluator = Context.get(
      yield* Layer.build(judge).pipe(
        Effect.mapError((cause) =>
          new LlmReviewError({ phase: "review", message: `Jev judge could not start: ${failureMessage(cause)}` })
        )
      ),
      Evaluator.Evaluator
    )
    const verdicts = yield* Effect.forEach(
      covered,
      (entry) => judgeFile(root, evaluator, payload, entry),
      { concurrency: options.concurrency ?? defaultConcurrency }
    ).pipe(
      // A judge must not follow a redirect with the gateway key, or send ambient credentials.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error", credentials: "omit" })
    )
    const findings = verdicts.flatMap((verdict) => verdict.findings)
    const report: Report = {
      files: covered.map((entry) => redactCredentials(entry.path)),
      findings,
      usage: {
        modelCalls: verdicts.filter((verdict) => verdict.judged).length,
        promptTokens: verdicts.reduce((total, verdict) => total + verdict.promptTokens, 0)
      }
    }
    if (findings.some((finding) => meets(finding.severity, payload.failOn))) {
      return yield* Effect.fail(new FindingsError({ failOn: payload.failOn, findings }))
    }
    return report
  }).pipe(Effect.scoped)

/**
 * Implements {@link JevReview} with {@link review}.
 *
 * @category layers
 * @since 1.0.0
 */
export const JevReviewLive = (
  options: ReviewOptions
): Layer.Layer<Action.Requirement<"smithers-build/jev-review">, never, FlowRuntime.FlowRuntime> =>
  JevReview.toLayer((payload) => review(options, payload))

/** Lowers declared attrs to the action payload: files become escaped globs and severities resolve. */
const payloadOf = (attrs: Attrs): Payload => ({
  rules: attrs.rules.map((rule) => ({
    id: rule.id,
    lookFor: rule.lookFor,
    violation: rule.violation,
    compliant: rule.compliant,
    files: rule.files.map((input) =>
      input._tag === "File" ? Input.glob(escape(input.path, { windowsPathsNoEscape: true })) : input
    ),
    severity: rule.severity ?? "error"
  })),
  threshold: attrs.threshold,
  failOn: attrs.failOn,
  model: attrs.model
})

/**
 * Judges files against rules with Jev and fails on findings.
 *
 * The plan is one {@link JevReview} call; see {@link review} for what it does.
 * The target joins `lint` but is manual by default, so `//...` never plans it
 * and naming its label does. Model output is not a reproducible function of
 * the inputs, so the target is never cached. Executing the plan requires
 * {@link JevReviewLive}.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const rules = Smithers.JevLint({
 *   rules: [{
 *     id: "durable.no-hand-rolled-retries",
 *     files: [Smithers.glob("//apps/mvp/worker/**\/*.ts")],
 *     lookFor: "Does this file write its own retry loop, sweep or background job?",
 *     violation: "The file hand-rolls durability a flow engine owns.",
 *     compliant: "The file has no retry loop, sweep or background job of its own."
 *   }]
 * })
 * ```
 *
 * @category targets
 * @since 1.0.0
 */
export const JevLint = Target.make("JevLint", {
  attrs: Attrs,
  kinds: ["lint"],
  success: Report,
  error: ReviewError,
  cache: false,
  manual: (attrs) => attrs.manual,
  implementation: (attrs) => JevReview.call(payloadOf(attrs))
})
