import { Data, Result, Schema } from "effect"

// Jev.config (decision 0173, Gate 4): a repository's maintainer-owned judgments, declared once in `.smithers/jev.vibe`.
// Every decision names its evaluators in order, what happens when none is sure (`onUnsure`) and what happens when one
// fails (`onFailure`). Both handlers are required, and neither can pass: a provider outage must never approve a pull
// request or spend inference nobody budgeted. A judge runs only where a decision lists it, on a seat the config
// declares, so there is no silent model fallback. `Jev.config` refuses a bad config at compile time. `decodeJevConfig`
// refuses the same configs at run time, for configs read from disk, with a typed `JevConfigError`, and `Jev.config`
// runs that same decoder, so a config cast past the compiler still cannot activate. Decoding is strict: a key the
// schema does not know, such as a misspelled decision name or handler, refuses the whole config instead of being
// dropped. A repository path cannot hold a `..` segment, and `resolveRepoPath` keeps the file it resolves to,
// symlinks followed, under the pinned checkout when the path is used.

/** Who owns a seat: a maintainer's login, as `maintainer:<login>`. */
const Owner = Schema.String.check(Schema.isPattern(/^maintainer:[A-Za-z0-9-]{1,39}$/))

/** Where a seat runs: an enrolled self-hosted node (`node:<name>`) or a budgeted Cloudflare sandbox (`sandbox:<name>`). */
const Runner = Schema.String.check(Schema.isPattern(/^(node|sandbox):[a-z0-9][a-z0-9-]{0,62}$/))

/** A seat: the model a maintainer pays for, where it runs, and its daily token budget. */
export const Seat = Schema.Struct({
  owner: Owner,
  runner: Runner,
  dailyTokens: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type Seat = typeof Seat.Type

const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9.-]{0,63}$/))
const Field = Schema.String.check(Schema.isPattern(/^[a-z][A-Za-z0-9.]{0,63}$/))
/**
 * A file in the repository, as `./<path>`. No segment may be `..` or `.`, and none may be empty, so a path names a
 * file under the checkout and cannot climb out of it.
 */
const RepoPath = Schema.String.check(
  Schema.isPattern(/^\.\/(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._\/-]{1,255}$/),
)
const Label = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,59}$/))
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000))
const Sure = Schema.Number.check(Schema.isBetween({ minimum: 0.5, maximum: 1 }))

/** The six evaluators, cheapest first. Only `judge` calls a model, and only on a declared seat. */
export const EVALUATOR_KINDS = ["pattern", "template", "path", "schema", "script", "judge"] as const
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number]

/** Matches a field against regular expressions, each mapped to the label it decides. */
const PatternEvaluator = Schema.Struct({
  use: Schema.Literal("pattern"),
  field: Field,
  match: Schema.Record(Text, Label),
})

/** Decides a label when a field follows a template, such as an issue template's headings. */
const TemplateEvaluator = Schema.Struct({ use: Schema.Literal("template"), field: Field, template: RepoPath, label: Label })

/** Decides a label from the paths a change touches. */
const PathEvaluator = Schema.Struct({ use: Schema.Literal("path"), match: Schema.Record(Text, Label) })

/** Decides a label when a field decodes against a schema file. */
const SchemaEvaluator = Schema.Struct({ use: Schema.Literal("schema"), field: Field, schema: RepoPath, label: Label })

/** Runs a repository script that prints a label or `unsure`. */
const ScriptEvaluator = Schema.Struct({ use: Schema.Literal("script"), script: RepoPath })

/** Asks a declared seat's model, and keeps its verdict only at or above `sure`. */
const JudgeEvaluator = Schema.Struct({ use: Schema.Literal("judge"), seat: Name, sure: Sure })

export const Evaluator = Schema.Union([
  PatternEvaluator,
  TemplateEvaluator,
  PathEvaluator,
  SchemaEvaluator,
  ScriptEvaluator,
  JudgeEvaluator,
])
export type Evaluator = typeof Evaluator.Type

/** Hand the item to people, on a named queue. */
const RequestHuman = Schema.Struct({ action: Schema.Literal("request-human"), who: Name })

/** Stop with a typed failure, shown on a named surface. */
const Fail = Schema.Struct({ action: Schema.Literal("fail"), surface: Name })

/** What happens when no evaluator is sure. There is no `pass`. */
export const OnUnsure = Schema.Union([RequestHuman, Fail])
export type OnUnsure = typeof OnUnsure.Type

/** What happens when an evaluator fails: a script crashes or a seat is unreachable or over budget. There is no `pass`. */
export const OnFailure = Schema.Union([Fail, RequestHuman])
export type OnFailure = typeof OnFailure.Type

/** One judgment a repository makes, such as `issue.kind`. */
export const Decision = Schema.Struct({
  kind: Schema.Literal("classify"),
  labels: Schema.Array(Label).check(Schema.isMinLength(2), Schema.isMaxLength(10)),
  evaluators: Schema.Array(Evaluator).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  onUnsure: OnUnsure,
  onFailure: OnFailure,
  examples: Schema.optional(RepoPath),
  minAccuracy: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
})
export type Decision = typeof Decision.Type

/** A repository's whole Jev config. */
export const JevConfig = Schema.Struct({
  seats: Schema.Record(Name, Seat),
  decisions: Schema.Record(Name, Decision),
})
export type JevConfig = typeof JevConfig.Type

/**
 * Why a config is refused: its shape, a judge on a seat it doesn't declare, a label a decision doesn't list, or a path
 * that resolves outside the checkout.
 */
export type JevConfigErrorCode = "invalid_shape" | "undeclared_seat" | "unknown_label" | "path_escape"

/** A refused config. `path` names the offending field, such as `decisions.issue.kind.evaluators.1.seat`. */
export class JevConfigError extends Data.TaggedError("JevConfigError")<{
  readonly code: JevConfigErrorCode
  readonly path: string
  readonly detail: string
}> {}

const labelsOf = (evaluator: Evaluator): ReadonlyArray<string> => {
  switch (evaluator.use) {
    case "pattern":
    case "path":
      return Object.values(evaluator.match)
    case "template":
    case "schema":
      return [evaluator.label]
    case "script":
    case "judge":
      return []
  }
}

/** Strict: an unknown or misspelled key anywhere fails the decode. Effect's default would drop it silently. */
const decodeStrict = Schema.decodeUnknownResult(JevConfig, { onExcessProperty: "error" })

/**
 * Decodes a config, or refuses it with the first {@link JevConfigError}. This is the only way a config becomes a
 * {@link JevConfig}: configs read from disk and configs declared through `Jev.config` both pass through it.
 */
export const decodeJevConfig = (input: unknown): Result.Result<JevConfig, JevConfigError> => {
  const decoded = decodeStrict(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(new JevConfigError({ code: "invalid_shape", path: "", detail: decoded.failure.message }))
  }
  const config = decoded.success
  for (const [name, decision] of Object.entries(config.decisions)) {
    for (const [index, evaluator] of decision.evaluators.entries()) {
      const at = `decisions.${name}.evaluators.${index}`
      if (evaluator.use === "judge" && !Object.hasOwn(config.seats, evaluator.seat)) {
        return Result.fail(new JevConfigError({
          code: "undeclared_seat",
          path: `${at}.seat`,
          detail: `seat ${evaluator.seat} is not in seats`,
        }))
      }
      const unknown = labelsOf(evaluator).find((label) => !decision.labels.includes(label))
      if (unknown !== undefined) {
        return Result.fail(new JevConfigError({
          code: "unknown_label",
          path: at,
          detail: `label ${unknown} is not in labels`,
        }))
      }
    }
  }
  return Result.succeed(config)
}

/** Whether `path` is a repository path: `./<path>` with no empty, `.` or `..` segment. */
export const isRepoPath = (path: string): boolean => Result.isSuccess(Schema.decodeUnknownResult(RepoPath)(path))

/**
 * Resolves a config's repository path for use: a script to run, or a schema or template to read. `realpath` follows
 * symlinks, as `fs.realpathSync` does. The result is the real file, and it is refused `path_escape` unless it lies
 * under the real checkout, so neither a `..` segment nor a symlink in the repository reaches a file outside it.
 *
 * The answer is a path checked once, not an open file: a writer who swaps the file or an ancestor afterwards redirects
 * a later open. A loader reads through `loadJevConfig` (worker/ci/WorkflowDiscovery.ts), which opens each file once
 * and proves the open file is the one it checked.
 */
export const resolveRepoPath = (input: {
  readonly checkout: string
  readonly path: string
  readonly realpath: (path: string) => string
}): Result.Result<string, JevConfigError> => {
  const escape = (detail: string) => Result.fail(new JevConfigError({ code: "path_escape", path: input.path, detail }))
  if (Result.isFailure(Schema.decodeUnknownResult(RepoPath)(input.path))) return escape("not a repository path")
  try {
    const root = input.realpath(input.checkout).replace(/\/+$/, "")
    const resolved = input.realpath(`${root}/${input.path.slice(2)}`)
    return resolved.startsWith(`${root}/`) ? Result.succeed(resolved) : escape("resolves outside the checkout")
    // expected: realpath throws on missing or unreadable targets, returned as a typed path_escape Result
  } catch {
    return escape("does not resolve")
  }
}

/** The compile-time view of a decision: a judge's seat must be one the config declares. */
type TypedEvaluator<S extends string> =
  | Exclude<Evaluator, { readonly use: "judge" }>
  | { readonly use: "judge"; readonly seat: S; readonly sure: number }

type TypedDecision<S extends string> = Omit<Decision, "evaluators"> & {
  readonly evaluators: ReadonlyArray<TypedEvaluator<S>>
}

/**
 * Declares a repository's Jev config. A decision without `onUnsure` or `onFailure`, a `pass` handler, or a judge on a
 * seat the config doesn't declare fails to compile. The value then passes through {@link decodeJevConfig}, and a
 * config that fails it throws its {@link JevConfigError}: a cast, a spread or plain JavaScript gets no further than the
 * compiler would have let it. The config returned is the decoded one.
 */
const config = <const S extends string>(value: {
  readonly seats: { readonly [K in S]: Seat }
  readonly decisions: { readonly [name: string]: TypedDecision<NoInfer<S>> }
}): JevConfig => {
  const decoded = decodeJevConfig(value)
  if (Result.isFailure(decoded)) throw decoded.failure
  return decoded.success
}

export const Jev = { config } as const
