/** Default memory gathering reuses the verified wiki and native JJ history.
 * Projects can replace GatherContext's action layer with their own workflow.
 */
import * as RecallKeyword from "../../packages/smithers/agent/memory/src/RecallKeyword.ts"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { operations as wikiOperations } from "../wiki/operations.ts"
import type { PageSpec } from "../wiki/schema.ts"
import { NativeCoding } from "./native.ts"
import { collectSources, extractPaths, readmePaths, reader as sourceReader, staleSources } from "./planning-sources.ts"
import { changedPaths, driftOf, GatherContext, memoryRevision, type Observed, PlanningContext, type PlanningInput, staleRevisionMessage, VerifyContext } from "./planning.ts"
import { type Check, CodingError } from "./schema.ts"

export interface MemoryOptions {
  readonly repositoryPath: string
  readonly wikiOutput: string
  readonly pages: ReadonlyArray<PageSpec>
  readonly implementation: string
  readonly checks: ReadonlyArray<Omit<Check, "flowDigest">>
  readonly historyLimit?: number
  readonly maxMemoryBytes?: number
}
const Page = Schema.Struct({
  id: Schema.NonEmptyString, title: Schema.String,
  kind: Schema.Literals(["current", "intent"]), body: Schema.NonEmptyString,
  inputDigest: Schema.NonEmptyString
})
const Pointer = Schema.Struct({
  artifactDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  sourceRevision: Schema.NonEmptyString, verification: Schema.Literal("verified"),
  pages: Schema.Array(Page).check(Schema.isMinLength(1), Schema.isMaxLength(30))
})
const failure = (message: string) => new CodingError({ code: "stale_revision", message })
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

/** No model or database participates in selecting and identifying source facts. */
export const gather = (options: MemoryOptions, input: typeof PlanningInput.Type, hostFilesystem?: FileSystem.FileSystem) => Effect.gen(function*() {
  const limit = options.historyLimit ?? 100, maximum = options.maxMemoryBytes ?? 48 * 1024
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maximum) || maximum < 1024 || maximum > 90 * 1024) {
    return yield* failure("Planning memory requires historyLimit 1..100 and maxMemoryBytes 1024..92160")
  }
  const fs = hostFilesystem ?? (yield* FileSystem.FileSystem), path = yield* Path.Path
  const native = yield* NativeCoding, jj = yield* Jj.Jj
  // The configured Jj captures current bytes in the SAME native atom. It never
  // opens a new change merely because memory needs an immutable code identity.
  yield* jj.snapshot("coding planning memory")
  const before = yield* native.read([], limit)
  if (!before.history?.length || before.history.some(row => row.kind !== "resolved") || before.head.kind !== "resolved") {
    return yield* failure("Planning requires bounded resolved native history; inspect conflicts or update the installed adapter")
  }
  const pointer = path.resolve(options.wikiOutput, "current.json")
  if ((yield* fs.stat(pointer)).size > BigInt(16 * 1024 * 1024)) return yield* failure("Wiki pointer exceeds the bounded planning input size")
  const captured = yield* fs.readFileString(pointer)
  // Use the owning verifier. Digest equality alone does not prove semantic
  // review, nor may old generated explanations silently stand in for new code.
  yield* wikiOperations({ root: options.repositoryPath, output: options.wikiOutput, fs: hostFilesystem }).check(options.pages, true)
  if ((yield* fs.readFileString(pointer)) !== captured) return yield* failure("Wiki publication changed while gathering memory; retry gathering")
  const wiki = yield* Effect.try({ try: () => JSON.parse(captured) as unknown, catch: () => failure("Invalid verified wiki pointer") }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Pointer)),
    Effect.mapError(() => failure("The wiki has no valid verified snapshot; regenerate it before planning"))
  )
  const terms = RecallKeyword.normalizeQueryTerms(`${input.prompt}\n${input.feedback}`)
  const ranked = wiki.pages.map(page => ({ page, score: RecallKeyword.scoreRow(terms, {
    key: `${page.id} ${page.title}`, text: page.body, tags: [], updatedAtMs: 0
  }) })).sort((left, right) => right.score - left.score || (left.page.id < right.page.id ? -1 : left.page.id > right.page.id ? 1 : 0))
  const memory: Array<typeof PlanningContext.Type["memory"][number]> = []
  for (const { page } of ranked) {
    const note = { id: page.id, title: page.title || page.id, kind: page.kind, markdown: page.body,
      sourceRevision: wiki.sourceRevision, inputDigest: page.inputDigest }
    // Keep complete pages. A truncated quotation or omitted caveat is not an
    // equivalent explanation; a project can supply a finer-grained gather flow.
    if (bytes([...memory, note]) <= maximum) memory.push(note)
  }
  if (memory.length === 0) return yield* failure("No complete wiki page fits the configured memory budget")
  const catalog = yield* Executable.Catalog
  const identity = (name: string) => {
    const entry = catalog.executables.find(entry => entry.descriptor.name === name)
    const digest = entry && Descriptor.executionDigest(entry.descriptor)
    if (!digest) throw new CodingError({ code: "unavailable", message: `Planning executable is unavailable or unverified: ${name}` })
    return digest
  }
  const definitions = yield* Effect.try({ try: () => ({
    implementation: options.implementation, implementationDigest: identity(options.implementation),
    checks: options.checks.map(check => ({ ...check, flowDigest: identity(check.flow) }))
  }), catch: error => error instanceof CodingError ? error : failure(String(error)) })
  const after = yield* native.read([], limit)
  if (before.operationId !== after.operationId || JSON.stringify(before.history) !== JSON.stringify(after.history)) {
    return yield* failure("Native history changed while gathering memory; gather a new coherent view")
  }
  const history = before.history.map(row => {
    if (row.kind !== "resolved") throw failure("Conflicted native history cannot be used to plan")
    return { changeId: row.changeId, commitId: row.commitId, treeId: row.treeId,
      operationId: row.operationId, parentCommitIds: row.parentCommitIds, description: row.description ?? "" }
  })
  // The planner asked humans to paste files it could have read. Attach the
  // request's own paths, the paths its chosen notes cite, and the repository
  // README, in that priority order, under the per-file and total caps.
  const reader = yield* sourceReader(options.repositoryPath, hostFilesystem)
  const named = extractPaths(input.prompt, input.feedback)
  const cited = extractPaths(...memory.map(note => note.markdown))
  const collected = yield* collectSources(reader, [...named, ...cited, ...(yield* readmePaths(reader))])
  const context = {
    head: before.head, history, memory, ...definitions, ...collected,
    memoryRevision: memoryRevision({ wiki: wiki.artifactDigest, history, memory, definitions,
      sources: collected.sources.map(({ digest, path }) => ({ path, digest })), missing: collected.missing })
  }
  // Attached file text carries its own per-file and total caps, so the budget
  // here still bounds the native history, the wiki notes and the definitions.
  if (bytes({ ...context, sources: [] }) > 128 * 1024) return yield* failure("Planning context exceeds 128 KiB; narrow the native history or wiki budget")
  return yield* Schema.decodeUnknownEffect(PlanningContext)(context).pipe(
    Effect.mapError(() => failure("Gathered planning context violates its native or catalog contract"))
  )
}).pipe(Effect.mapError(error => error instanceof CodingError ? error : failure(
  "Planning memory is unavailable or source-stale: " + (error instanceof Error ? error.message : String(error))
)))

/** The caller supplies existing host services; no storage or platform is opened.
 * Explicit host filesystem injection survives native action context restoration.
 */
export const memoryLayer = (options: MemoryOptions, hostFilesystem?: FileSystem.FileSystem) => Layer.mergeAll(
  GatherContext.toLayer(input => gather(options, input, hostFilesystem)),
  VerifyContext.toLayer(({ context }) => Effect.gen(function*() {
    const jj = yield* Jj.Jj, native = yield* NativeCoding
    yield* jj.snapshot("coding planning freshness")
    const current = yield* native.read(context.history.map(row => row.changeId))
    const headDrift = driftOf(context.head, current.head as Observed)
    const drift = [
      ...(headDrift === undefined ? [] : [`head ${headDrift}`]),
      ...context.history.flatMap(row => {
        const reason = driftOf(row, current.revisions.find(value => value.changeId === row.changeId) as Observed | undefined)
        return reason === undefined ? [] : [reason]
      })
    ]
    if (drift.length > 0) {
      // The paths are the whole diagnosis. The 2026-09-15 workspace failure was
      // the host's own `.flows/control.db` and `.flows/engine.db-wal` landing
      // inside the working copy it was planning against, and the run card said
      // only that native code had changed. `diff` is best effort: a plan must
      // still be refused when the adapter cannot explain why.
      const paths = current.head.kind === "resolved" && context.head.commitId !== current.head.commitId
        ? yield* jj.diff(context.head.commitId, current.head.commitId).pipe(
          Effect.map(changedPaths), Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>))
        )
        : []
      return yield* failure(staleRevisionMessage(drift, paths))
    }
    // A plan may not be finalized against file text the planner no longer sees.
    const stale = yield* staleSources(yield* sourceReader(options.repositoryPath, hostFilesystem),
      { sources: context.sources ?? [], missing: context.missing ?? [] })
    if (stale.length > 0) return yield* failure(`Attached source files changed during planning or clarification; gather and plan again: ${stale.join(", ")}`)
    yield* wikiOperations({ root: options.repositoryPath, output: options.wikiOutput, fs: hostFilesystem }).check(options.pages, true)
    return context
  }).pipe(Effect.mapError(error => error instanceof CodingError ? error : failure(
    "Planning context no longer matches current source: " + (error instanceof Error ? error.message : String(error))
  ))))
)
