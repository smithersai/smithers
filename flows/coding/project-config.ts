/** Private operator input, loaded once before the configured host is constructed. */
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { PageSpec } from "../wiki/schema.ts"
import type { MemoryOptions } from "./planning-memory.ts"
import { Check } from "./schema.ts"
import { separateWikiOutput } from "./wiki-output.ts"

const { flowDigest: _flowDigest, ...checkFields } = Check.fields
const text = Schema.NonEmptyString
const Project = Schema.Struct({
  wikiOutput: text,
  pages: Schema.Array(PageSpec).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  implementation: text,
  checks: Schema.Array(Schema.Struct(checkFields)),
  historyLimit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))),
  maxMemoryBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1024), Schema.isLessThanOrEqualTo(90 * 1024))),
  reviewer: text
})
export type ProjectConfig = Omit<MemoryOptions, "repositoryPath"> & { readonly reviewer: string }
const invalid = (message: string) => new Error(`Invalid SMITHERS_CODING_PROJECT: ${message}`)
const maximumBytes = 256 * 1024

/** No discovery, writes or extra connection. Relative paths are repository-relative. */
export const loadProject = (repositoryPath: string, filename: string | undefined): Effect.Effect<
  ProjectConfig | undefined, Error, FileSystem.FileSystem | Path.Path
> => Effect.gen(function*() {
  if (filename === undefined) return undefined
  if (!filename.trim() || filename.includes("\0")) return yield* Effect.fail(invalid("the explicit filename must be nonempty"))
  const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
  // bytesToRead bounds even a growing file; the extra byte distinguishes an
  // exact-bound document from a truncated one. Check emitted bytes as well.
  const data = yield* Stream.runFoldEffect(fs.stream(path.resolve(repositoryPath, filename), {
    bytesToRead: maximumBytes + 1, chunkSize: 16 * 1024
  }), () => ({ chunks: [] as Uint8Array[], bytes: 0 }), (state, chunk) => {
    if (state.bytes + chunk.length > maximumBytes) return Effect.fail(invalid("JSON exceeds 256 KiB"))
    state.chunks.push(chunk)
    state.bytes += chunk.length
    return Effect.succeed(state)
  }).pipe(Effect.mapError(error => error instanceof Error && error.message.startsWith("Invalid SMITHERS_CODING_PROJECT:")
    ? error : invalid("cannot read the explicit file")))
  const bytes = new Uint8Array(data.bytes)
  let offset = 0
  for (const chunk of data.chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const input = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    catch: () => invalid("expected UTF-8 JSON")
  })
  const project = yield* Schema.decodeUnknownEffect(Project, { onExcessProperty: "error" })(input).pipe(
    // Do not print operator configuration contents in startup diagnostics.
    Effect.mapError(() => invalid("fields must match the project schema; unknown fields are refused"))
  )
  const pageIds = new Set(project.pages.map(page => page.id))
  if (pageIds.size !== project.pages.length || project.pages.some(page => !/^[a-z][a-z0-9-]{0,80}$/.test(page.id))) {
    return yield* Effect.fail(invalid("wiki page IDs must be valid and unique"))
  }
  if (project.pages.some(page => page.related.some(id => !pageIds.has(id)))) {
    return yield* Effect.fail(invalid("related wiki pages must exist in this configuration"))
  }
  if (new Set(project.checks.map(check => check.id)).size !== project.checks.length) {
    return yield* Effect.fail(invalid("check IDs must be unique"))
  }
  if (!project.wikiOutput.trim() || project.wikiOutput.includes("\0") || !project.reviewer.trim() || !project.implementation.trim()) {
    return yield* Effect.fail(invalid("output, reviewer and implementation must be nonempty"))
  }
  const wikiOutput = yield* separateWikiOutput(repositoryPath, project.wikiOutput).pipe(
    Effect.mapError(() => invalid("wikiOutput must resolve outside the source workspace, including .flows")))
  return { ...project, wikiOutput }
})
