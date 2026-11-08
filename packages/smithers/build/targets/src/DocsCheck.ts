/**
 * `S.Docs.Check`: freshness for generated and authored documentation.
 *
 * `Agent.Diff` and `Docs.Page` are `cache: false` because an agent is not a
 * pure function of its inputs, so the tree itself is the cache: a generated
 * page is committed beside a stamp recording the content key of every input
 * the writer read and the digest of the page it produced. This rule
 * recomputes that key and fails, deterministically and without spawning an
 * agent, when the committed page is older than what produced it.
 *
 * The key is not a hash this module invents. The planner already digests
 * every declared input at plan time (`Workspace.ExpandedInput.files`, one
 * `{path, digest}` row per file); {@link closureDigest} is that same encoding
 * applied to the union of the rows the `inputs` attr resolves to. The verdict
 * and the node's own cache key use the same input encoding. Evidence records
 * contribute their observed state instead of their collection timestamp;
 * these time-dependent checks always execute. It deliberately is not the node's key preview: that folds in
 * the executor implementation fingerprint, the attrs schema identity, and the
 * execution mode, so a committed stamp equal to it would rot on every build
 * tool release rather than only when an input moved.
 *
 * One sidecar per page, not one manifest per package: a shared manifest makes
 * every regeneration a merge conflict and every stale page a site-wide red,
 * while a sidecar fails one page and diffs beside it.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/**
 * The stamp layout this module writes and reads. A stamp of another format
 * is not a stamp: the check reports it `missing` so the page is re-stamped
 * rather than judged against fields that no longer mean what they did.
 *
 * @category constants
 * @since 0.1.0
 */
export const stampFormat = 1

/**
 * Schema for one file recorded in a stamp: its workspace-relative path and
 * its content digest, `null` when the file did not exist when the stamp was
 * written. A declared-but-absent input is still part of the closure, so its
 * later appearance is a change.
 *
 * @category schemas
 * @since 0.1.0
 */
export const StampFile = Schema.Struct({
  path: Schema.NonEmptyString,
  digest: Schema.NullOr(Schema.String)
})

/**
 * One file recorded in a stamp.
 *
 * @category models
 * @since 0.1.0
 */
export type StampFile = typeof StampFile.Type

/**
 * Explicit metadata omissions. Only named top-level, single-line YAML values
 * and named level-two ATX sections are omitted; fenced examples are preserved.
 * Keep semantic claims outside these fields. Complex or ambiguous syntax is
 * refused rather than normalized away. No whitespace or prose is rewritten.
 * @category schemas
 * @since 1.0.0
 */
export const Ignore = Schema.Struct({
  frontmatterKeys: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  sections: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

/** Explicit metadata omissions.
 * @category models
 * @since 1.0.0
 */
export type Ignore = typeof Ignore.Type

/** Normalization cannot safely interpret the selected metadata.
 * @category errors
 * @since 1.0.0
 */
export class NormalizationError extends Schema.TaggedError<NormalizationError>()(
  "smithers-build/DocsNormalizationError",
  { message: Schema.NonEmptyString }
) {}

const policy = (ignore: Ignore | undefined): Ignore => ({
  frontmatterKeys: [...new Set(ignore?.frontmatterKeys ?? [])].sort(),
  sections: [...new Set(ignore?.sections ?? [])].sort()
})

/**
 * Removes only explicitly selected verification metadata. With no omissions,
 * returns the exact original bytes. Frontmatter uses simple unquoted keys;
 * selected values must be single-line scalars. Unterminated frontmatter,
 * multiline quoted/flow YAML, HTML blocks and unclosed code fences fail closed.
 * @category normalization
 * @since 1.0.0
 */
export const normalize = (text: string, ignore?: Ignore): string => {
  const keys = new Set(ignore?.frontmatterKeys ?? [])
  const sections = new Set(ignore?.sections ?? [])
  if (keys.size === 0 && sections.size === 0) return text
  const fail = (message: string): never => {
    throw new NormalizationError({ message })
  }
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const plain = (line: string): string => line.replace(/\r?\n$/, "")
  const kept: Array<string> = []
  let start = 0
  if (plain(lines[0] ?? "") === "---") {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)$/.test(plain(line)))
    if (end < 0) return fail("Docs.Check normalization requires closed YAML frontmatter")
    kept.push(lines[0]!)
    for (let index = 1; index < end; index += 1) {
      const line = lines[index]!
      const entry = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(plain(line))
      if (keys.size > 0) {
        const value = entry?.[2]?.trim() ?? ""
        if (/^[[{'"]/.test(value)) {
          // Support only complete simple quoted values and flat flow scalars.
          // A trailing escaped quote/bracket is not proof a YAML value closed.
          const simple = /^'[^']*'$/.test(value) || /^"[^"\\]*"$/.test(value) ||
            /^\[[^[\]{}'"]*\]$/.test(value) || /^\{[^[\]{}'"]*\}$/.test(value)
          if (!simple) return fail("Docs.Check normalization requires single-line quoted or flow YAML frontmatter")
        }
        if (/^[&*!]/.test(value) || (entry === null && !/^[ \t]*(?:#.*)?$/.test(plain(line)))) {
          return fail("Docs.Check normalization requires simple YAML frontmatter keys and values")
        }
        if (entry !== null && keys.has(entry[1]!)) {
          const next = plain(lines[index + 1]!)
          if (/^[|>[{&*!]/.test(value) || (/^[ \t]+\S/.test(next))) {
            return fail("Docs.Check ignored frontmatter values must be single-line scalars")
          }
          // Preserve the key and its position. Deleting a YAML line can turn an
          // adjacent plain scalar into a continuation of the preceding field.
          kept.push(`${entry[1]}: null${line.endsWith("\r\n") ? "\r\n" : "\n"}`)
          continue
        }
      }
      kept.push(line)
    }
    kept.push(lines[end]!)
    start = end + 1
  }
  let omitted = false
  let fence: { readonly char: string; readonly size: number } | undefined
  for (const line of lines.slice(start)) {
    const content = plain(line)
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content)
    if (fence !== undefined) {
      if (
        marker !== null && marker[1]![0] === fence.char && marker[1]!.length >= fence.size && marker[2]!.trim() === ""
      ) {
        fence = undefined
      }
    } else if (marker !== null) {
      if (sections.size > 0 && (content.startsWith(" ") || (marker[1]![0] === "`" && marker[2]!.includes("`")))) {
        return fail("Docs.Check section normalization requires unindented fences with unambiguous info strings")
      }
      fence = { char: marker[1]![0]!, size: marker[1]!.length }
    } else if (sections.size > 0) {
      if (/^ {0,3}</.test(content) || content.includes("<!--")) {
        return fail("Docs.Check section normalization does not support HTML blocks or comments")
      }
      if (omitted && /^ {0,3}(?:=+|-+)[ \t]*$/.test(content)) {
        return fail("Docs.Check ignored sections require ATX headings, not ambiguous Setext headings")
      }
      const heading = /^ {0,3}(#{1,2})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(content)
      if (heading !== null) omitted = heading[1] === "##" && sections.has(heading[2]!)
    }
    if (!omitted) kept.push(line)
  }
  if (sections.size > 0 && fence !== undefined) {
    return fail("Docs.Check section normalization requires closed code fences")
  }
  return kept.join("")
}

/** A local observation collected separately by a durable collector flow.
 * `digest` identifies the external state, not its collection time. Timestamps
 * are Unix milliseconds. The check never reaches a URL, live service or home.
 * @category schemas
 * @since 1.0.0
 */
export const Evidence = Schema.Struct({
  format: Schema.Literal(1),
  dependency: Schema.NonEmptyString,
  observedAt: Schema.Number,
  digest: Schema.NonEmptyString
})

/** A declared, workspace-local observation and the maximum age the owner allows.
 * @category schemas
 * @since 1.0.0
 */
export const EvidenceInput = Schema.Struct({
  file: Input.File,
  dependency: Schema.NonEmptyString,
  ttlMs: Schema.Number
})

/** A declared local observation.
 * @category models
 * @since 1.0.0
 */
export type EvidenceInput = typeof EvidenceInput.Type

/**
 * Evaluates an already-collected observation without performing any I/O.
 * Missing, malformed, future-dated and expired records are unknown. A renewed
 * observation of unchanged state has the same digest and needs no re-stamp.
 * @category validation
 * @since 1.0.0
 */
export const evidenceDigest = (text: string | undefined, input: EvidenceInput, now: number): string | undefined => {
  if (text === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const decoded = Schema.decodeUnknownOption(Evidence, { onExcessProperty: "error" })(value)
  if (decoded._tag === "None") return undefined
  const record = decoded.value
  if (
    record.dependency !== input.dependency || !Number.isSafeInteger(now) || now < 0 ||
    !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0 ||
    !Number.isSafeInteger(record.observedAt) || record.observedAt < 0 ||
    record.observedAt > now || now - record.observedAt >= input.ttlMs
  ) return undefined
  return Input.digestText(JSON.stringify({ dependency: record.dependency, digest: record.digest }))
}

/**
 * Schema for the committed sidecar that records what produced one page.
 *
 * `closure` is {@link closureDigest} over `inputs`, kept beside the list it
 * summarizes so a reader compares one line and a diff shows which path moved.
 * `producer` is provenance only, a model id or a prompt path; it is written
 * for the record and never compared.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Stamp = Schema.Struct({
  format: Schema.Literal(stampFormat),
  producer: Schema.NullOr(Schema.String),
  output: StampFile,
  closure: Schema.NonEmptyString,
  inputs: Schema.Array(StampFile),
  ignore: Schema.optional(Ignore)
})

/**
 * The committed sidecar that records what produced one page.
 *
 * @category models
 * @since 0.1.0
 */
export type Stamp = typeof Stamp.Type

/**
 * Why one freshness check failed.
 *
 * `stale`: an input moved after the stamp was written, so the page has to be
 * regenerated or re-verified. `modified`: the page or its normalization policy
 * changed after the stamp. `missing`: there is no stamp or no page. `unknown`:
 * external evidence is unavailable or expired, so freshness cannot be judged.
 * A separate collector renews evidence before the writer can re-verify it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const StaleReason = Schema.Literals(["stale", "modified", "missing", "unknown"])

/**
 * Why one freshness check failed.
 *
 * @category models
 * @since 0.1.0
 */
export type StaleReason = typeof StaleReason.Type

/**
 * A committed page is older than its inputs, was edited after it was
 * stamped, or has no stamp.
 *
 * `page` is the generated file the check judged, `stamp` is its sidecar, and
 * `path` is the first path that explains the verdict: the input that moved
 * for `stale`, the page for `modified`, the stamp or the page for `missing`.
 *
 * @category errors
 * @since 0.1.0
 */
export class StaleError extends Schema.TaggedError<StaleError>()(
  "smithers-build/StaleError",
  {
    page: Schema.NonEmptyString,
    stamp: Schema.NonEmptyString,
    reason: StaleReason,
    path: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }
) {}

/** Sorts by UTF-16 code unit, the order {@link Input.digestFiles} uses. */
const byPath = (left: { readonly path: string }, right: { readonly path: string }): number =>
  left.path < right.path ? -1 : 1

/**
 * The resolved rows in the planner's canonical form: one row per path, sorted
 * by path, `digest` left undefined for a file that does not exist. A file two
 * globs both match contributes one row; two rows disagreeing about one path's
 * content are an ambiguous closure and refused.
 */
const canonicalRows = (
  files: ReadonlyArray<Input.FileDigest | StampFile>
): ReadonlyArray<Input.FileDigest> => {
  const rows = new Map<string, Input.FileDigest>()
  for (const file of files) {
    const digest = file.digest ?? undefined
    const existing = rows.get(file.path)
    if (existing !== undefined && existing.digest !== digest) {
      throw new Error(
        `the input closure names ${JSON.stringify(file.path)} twice, with two different digests`
      )
    }
    rows.set(file.path, digest === undefined ? { path: file.path, digest: undefined } : { path: file.path, digest })
  }
  return [...rows.values()].sort(byPath)
}

/**
 * The content key of one page's input closure.
 *
 * This is the planner's own per-input encoding — `Input.digestText` over the
 * JSON of the sorted `{path, digest}` rows, a row without a digest for a
 * declared file that is absent — applied to the union of every input's rows.
 * The order the rows arrive in does not matter, and a path listed twice
 * counts once, so the key depends on the files' paths and contents and on
 * nothing about how they were declared or listed.
 *
 * @category digests
 * @since 0.1.0
 */
export const closureDigest = (files: ReadonlyArray<Input.FileDigest | StampFile>): string =>
  Input.digestText(JSON.stringify(canonicalRows(files)))

const stampFile = (file: Input.FileDigest | StampFile): StampFile => ({
  path: file.path,
  digest: file.digest ?? null
})

/**
 * Builds the stamp for a page as it stands now, with its inputs sorted.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeStamp = (options: {
  readonly producer: string | null | undefined
  readonly output: Input.FileDigest
  readonly inputs: ReadonlyArray<Input.FileDigest>
  readonly ignore?: Ignore | undefined
}): Stamp => {
  const rows = canonicalRows(options.inputs)
  return {
    format: stampFormat,
    producer: options.producer ?? null,
    output: stampFile(options.output),
    closure: closureDigest(rows),
    inputs: rows.map(stampFile),
    ...(options.ignore === undefined ? {} : { ignore: policy(options.ignore) })
  }
}

/**
 * Renders a stamp as the committed JSON text: two-space indent, fixed key
 * order, trailing newline, so two stamps over one closure are byte-equal.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderStamp = (stamp: Stamp): string =>
  `${
    JSON.stringify(
      {
        format: stamp.format,
        producer: stamp.producer,
        output: { path: stamp.output.path, digest: stamp.output.digest },
        closure: stamp.closure,
        inputs: stamp.inputs.map((file) => ({ path: file.path, digest: file.digest })),
        ...(stamp.ignore === undefined ? {} : { ignore: policy(stamp.ignore) })
      },
      null,
      2
    )
  }\n`

const decodeStamp = Schema.decodeUnknownOption(Stamp)

/**
 * Reads a stamp back out of its committed text, or nothing when the text is
 * not a stamp of the current format.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parseStamp = (text: string): Stamp | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const decoded = decodeStamp(parsed)
  return decoded._tag === "Some" ? decoded.value : undefined
}

/**
 * How one input differs between a stamp and the tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface Difference {
  readonly path: string
  readonly change: "added" | "removed" | "changed"
}

/**
 * The first path, in sorted order, at which two closures disagree.
 *
 * `added` and `removed` are relative to `before`: a path only `after` has
 * was added to the closure, a path only `before` has was removed from it.
 *
 * @category digests
 * @since 0.1.0
 */
export const firstDifference = (
  before: ReadonlyArray<Input.FileDigest | StampFile>,
  after: ReadonlyArray<Input.FileDigest | StampFile>
): Difference | undefined => {
  const previous = canonicalRows(before)
  const current = canonicalRows(after)
  let left = 0
  let right = 0
  while (left < previous.length || right < current.length) {
    const was = previous[left]
    const is = current[right]
    if (was === undefined) return { path: is!.path, change: "added" }
    if (is === undefined) return { path: was.path, change: "removed" }
    if (was.path < is.path) return { path: was.path, change: "removed" }
    if (was.path > is.path) return { path: is.path, change: "added" }
    if (was.digest !== is.digest) return { path: was.path, change: "changed" }
    left += 1
    right += 1
  }
  return undefined
}

/**
 * Judges one page against its stamp, or passes it.
 *
 * `stamp` is the parsed sidecar, undefined when there is none. `output` is
 * the page as it stands in the tree and `inputs` is its closure as the
 * planner resolved it now. The verdict is the closure key, the same bytes the
 * node was keyed on; {@link firstDifference} only names the path that
 * explains it. A closure mismatch wins over a modified page: regeneration
 * answers both, and the input that moved is the more useful thing to name.
 *
 * @category validation
 * @since 0.1.0
 */
export const judge = (options: {
  readonly page: string
  readonly stampPath: string
  readonly stamp: Stamp | undefined
  readonly output: Input.FileDigest
  readonly inputs: ReadonlyArray<Input.FileDigest>
  readonly ignore?: Ignore | undefined
  readonly authored?: boolean | undefined
}): StaleError | undefined => {
  const { page, stampPath } = options
  const fail = (reason: StaleReason, path: string, message: string): StaleError =>
    new StaleError({
      page,
      stamp: stampPath,
      reason,
      path,
      message: options.authored === true
        ? `${message.replace(/;[^;]*$/, "")}; re-verify the doc, then smthrs docs --write <label>`
        : message
    })
  if (options.stamp === undefined) {
    return fail("missing", stampPath, `${page} has no stamp at ${stampPath}; regenerate the page and stamp it`)
  }
  if (options.output.digest === undefined) {
    return fail("missing", page, `${page} is missing but ${stampPath} stamps it; regenerate the page`)
  }
  if (JSON.stringify(policy(options.ignore)) !== JSON.stringify(policy(options.stamp.ignore))) {
    return fail(
      "modified",
      page,
      `${page} normalization policy changed since ${stampPath} was written; regenerate the page`
    )
  }
  if (closureDigest(options.inputs) !== options.stamp.closure) {
    // A hand-corrupted stamp can name one path twice, which no closure this
    // module writes ever does. That is answered by regenerating like any
    // other mismatch, so it reports the verdict rather than throwing out of
    // the executor's lane.
    let difference: Difference | undefined
    try {
      difference = firstDifference(options.stamp.inputs, options.inputs)
    } catch {
      difference = undefined
    }
    if (difference === undefined) {
      return fail(
        "stale",
        page,
        `${page} was stamped against an input closure whose key has moved; regenerate the page`
      )
    }
    const verb = difference.change === "changed" ? "changed" : `was ${difference.change}`
    return fail(
      "stale",
      difference.path,
      `${page} is stale: input ${difference.path} ${verb} since ${stampPath} was written; regenerate the page`
    )
  }
  if (options.stamp.output.digest !== options.output.digest) {
    return fail(
      "modified",
      page,
      `${page} was edited after ${stampPath} was written; put the change in the brief or the prompt and regenerate`
    )
  }
  return undefined
}

/**
 * Schema for one member of the `inputs` attr: a declared file, a declared
 * glob, or a target whose files the page was written from (a Filegroup).
 * A git diff is not a producer of a page and is refused by shape.
 *
 * @category schemas
 * @since 0.1.0
 */
export const InputMember = Schema.Union([Target.Target, Input.File, Input.Glob])

/**
 * One member of the `inputs` attr.
 *
 * @category models
 * @since 0.1.0
 */
export type InputMember = typeof InputMember.Type

/**
 * Schema for the `inputs` attr. `S.glob([...])` returns an array, so a
 * member may itself be an array of members.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Inputs = Schema.Array(Schema.Union([InputMember, Schema.Array(InputMember)]))

/**
 * Attributes for {@link Check}.
 *
 * `stamp` is the committed sidecar, `output` is the generated page, and
 * `inputs` is everything the writer read to produce it. All three resolve
 * the way every declared input does: `//` from the workspace root, otherwise
 * from the declaring package. `producer` is recorded in the stamp as
 * provenance, a model id or a prompt path, and never compared.
 * `authored: true` asks a person or role to re-verify rather than regenerate.
 * `ignore: { frontmatterKeys: ["verified"], sections: ["Log"] }` opts into
 * metadata normalization; its policy is recorded in the stamp. Evidence is
 * declared as `{ file: S.file("evidence.json"), dependency: "live:service",
 * ttlMs: 3600000 }`. A separate collector writes {@link Evidence} records;
 * checks and `--write` both fail `unknown` without a current observation.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  stamp: Input.File,
  output: Input.File,
  inputs: Inputs,
  producer: Schema.optional(Schema.NonEmptyString),
  authored: Schema.optional(Schema.Boolean),
  ignore: Schema.optional(Ignore),
  evidence: Schema.optional(Schema.Array(EvidenceInput))
})

/**
 * Attributes for {@link Check}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

const definition = Target.make("Docs.Check", {
  // `lint` and `docs` are the checking verbs, so the aggregate `ci` (which
  // plans both) fails on a stale page and never rewrites a committed file.
  // The refresh is `docs --write`, matching `Generate`, `Owners.*`, and
  // `Github.CiGen`: an unattended verb checks, an explicit flag applies.
  kinds: ["lint", "docs"],
  attrs: Attrs,
  error: Schema.Union([StaleError, Target.NotImplemented]),
  // Everything the verdict depends on is key material: the stamp, the page,
  // and every input are declared inputs of this node, and a Filegroup
  // member's key covers its files.
  // Time is deliberately not key material: evidence checks always execute so a
  // previously green observation cannot outlive its TTL in either cache tier.
  cache: (attrs) => (attrs.evidence?.length ?? 0) === 0,
  implementation: () => Target.notImplemented("Docs.Check")
})

/** The declared file paths a member array names, arrays flattened. */
const declaredPaths = (members: ReadonlyArray<unknown>): ReadonlyArray<string> => {
  const paths: Array<string> = []
  for (const member of members) {
    for (const entry of Array.isArray(member) ? member : [member]) {
      if (Input.isDeclared(entry) && entry._tag === "File") paths.push(entry.path)
    }
  }
  return paths
}

/**
 * Checks that a committed agent-written page is no older than its inputs.
 *
 * Under `lint` and plain `docs`, and therefore under `ci`, the executor
 * digests the page and every file the `inputs` reach — through Filegroups,
 * with the rows the plan keyed the node on — reads the stamp, and fails with
 * {@link StaleError} when an input moved (`stale`), the page was edited after
 * it was stamped (`modified`), or there is no stamp or no page (`missing`).
 * The failure names the page and the first path that explains it. Under
 * `docs --write`, or the bare label with `--write`, the executor writes the
 * stamp for the page as it stands, which is the step a writer runs after
 * regenerating.
 *
 * Without external evidence the check is a pure function of declared files
 * and a green verdict is cached. Evidence checks also depend on the clock,
 * so they always execute and refuse missing or expired observations.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * export const fresh = S.Docs.Check({
 *   stamp: S.file("//apps/site/pages/intro/stamp.json"),
 *   output: S.file("//apps/site/src/content/docs/docs/intro.mdx"),
 *   inputs: [S.file("//apps/site/pages/intro/brief.md"), S.glob("//packages/flow/src/*.ts")],
 *   producer: "claude-opus-5 prompts/tutorial.md"
 * })
 * ```
 *
 * @category targets
 * @since 0.1.0
 */
export const Check = Target.guard(definition, (attrs) => {
  const evidencePaths = new Set<string>()
  for (const evidence of attrs.evidence ?? []) {
    if (!Number.isSafeInteger(evidence.ttlMs) || evidence.ttlMs <= 0) {
      throw new NormalizationError({ message: "Docs.Check evidence ttlMs must be a positive safe integer" })
    }
    if (
      evidencePaths.has(evidence.file.path) || evidence.file.path === attrs.stamp.path ||
      evidence.file.path === attrs.output.path
    ) {
      throw new NormalizationError({
        message: "Docs.Check evidence files must be distinct from one another, the page and the stamp"
      })
    }
    evidencePaths.add(evidence.file.path)
  }
  const stamp = attrs.stamp?.path
  const output = attrs.output?.path
  if (stamp !== undefined && stamp === output) {
    throw new Error(
      `Docs.Check names ${
        JSON.stringify(stamp)
      } as both the stamp and the page; one file cannot stamp itself, they must not be the same file`
    )
  }
  for (const path of declaredPaths(attrs.inputs)) {
    if (path === stamp || path === output) {
      throw new Error(
        `Docs.Check lists ${JSON.stringify(path)} as its own input; the stamp and the page are what the inputs produce`
      )
    }
  }
})
