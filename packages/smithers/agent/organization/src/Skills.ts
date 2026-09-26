/**
 * The pinned skill pack roles draw their curated skills from.
 *
 * A pack is a directory of `<skill>/SKILL.md` files in the Agent Skills
 * format: YAML frontmatter (every scalar a string) with `name`,
 * `description`, `license`, and optional `compatibility`, `allowed-tools`, and
 * `metadata`, followed by the instructions. {@link loadPack} refuses a skill
 * whose license is neither in {@link allowedLicenses} nor a `LicenseRef-`
 * identifier, whose name differs from its directory, or that is marked `metadata.adapted: "true"` without the
 * `metadata.source` and `metadata.revision` it was adapted from. Every read
 * is confined to the real path of the pack directory.
 *
 * A skill carries text only. `allowed-tools` is recorded as written and grants
 * nothing: a principal's authority comes from its profile grants alone.
 *
 * Each skill's revision is the SHA-256 of its `SKILL.md`, and the pack
 * revision is the SHA-256 of the canonical JSON of every name and revision,
 * so a role prompt can pin the exact instructions it used.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { canonicalDigest, sha256Hex } from "./internal/digest.ts"
import * as Frontmatter from "./internal/frontmatter.ts"
import type * as Prompt from "./Prompt.ts"

/**
 * The public licenses a pack may carry. An organization's own skills may
 * instead carry an SPDX `LicenseRef-<name>` identifier.
 *
 * @category constants
 * @since 1.0.0
 */
export const allowedLicenses: ReadonlyArray<string> = ["Apache-2.0", "MIT", "CC-BY-4.0"]

/** An SPDX user-defined license reference, such as an organization's private license. */
const licenseRef = /^LicenseRef-[A-Za-z0-9.-]+$/

/**
 * The largest `SKILL.md` {@link loadPack} reads.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxSkillBytes = 262_144

/**
 * One loaded skill.
 *
 * @category models
 * @since 1.0.0
 */
export interface Skill {
  readonly name: string
  readonly description: string
  readonly license: string
  readonly compatibility?: string
  readonly allowedTools?: string
  readonly metadata: Readonly<Record<string, string>>
  /** The instructions after the frontmatter. */
  readonly body: string
  /** The SHA-256 of the whole `SKILL.md`. */
  readonly revision: string
  /** The file's path relative to the pack directory. */
  readonly path: string
}

/**
 * A loaded pack: skills by name, in name order, and the pack revision.
 *
 * @category models
 * @since 1.0.0
 */
export interface Pack {
  readonly revision: string
  readonly skills: ReadonlyMap<string, Skill>
}

/**
 * Stable skill pack failure codes.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SkillsErrorCode = Schema.Literals([
  "read",
  "confinement",
  "too-large",
  "frontmatter",
  "unknown-key",
  "name",
  "description",
  "license",
  "metadata",
  "provenance",
  "missing"
])

/**
 * A skill pack failure code.
 *
 * @category models
 * @since 1.0.0
 */
export type SkillsErrorCode = typeof SkillsErrorCode.Type

/**
 * A skill that could not be loaded or selected. `path` is relative to the
 * pack; the message never repeats a field's value.
 *
 * @category errors
 * @since 1.0.0
 */
export class SkillsError extends Schema.TaggedError<SkillsError>()("@smthrs/organization/Skills/SkillsError", {
  code: SkillsErrorCode,
  path: Schema.String,
  field: Schema.optionalKey(Schema.String),
  message: Schema.String
}) {}

const knownKeys = new Set(["name", "description", "license", "compatibility", "allowed-tools", "metadata"])
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Parses one `SKILL.md` found in directory `directory` of a pack.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseSkill = (
  directory: string,
  text: string
): Result.Result<Skill, SkillsError> => {
  const path = `${directory}/SKILL.md`
  const refuse = (code: SkillsErrorCode, field: string | undefined, message: string) =>
    Result.fail(new SkillsError({ code, path, ...(field === undefined ? {} : { field }), message }))
  const split = Frontmatter.split(text)
  if (split.frontmatter === undefined) return refuse("frontmatter", undefined, "a skill starts with --- frontmatter")
  const parsed = Frontmatter.parse(split.frontmatter, "failsafe")
  if (!parsed.ok) return refuse("frontmatter", undefined, parsed.error)
  const fields = parsed.value
  for (const key of Object.keys(fields)) {
    if (!knownKeys.has(key)) return refuse("unknown-key", key, "is not an Agent Skills frontmatter key")
  }
  const { description, license, metadata, name } = fields
  if (typeof name !== "string" || name.length > 64 || !skillName.test(name)) {
    return refuse("name", "name", "is 1 to 64 lowercase letters, digits, and single hyphens")
  }
  if (name !== directory) return refuse("name", "name", "matches the skill's directory name")
  if (typeof description !== "string" || description.trim().length === 0 || description.length > 1024) {
    return refuse("description", "description", "is 1 to 1024 characters")
  }
  if (typeof license !== "string" || !(allowedLicenses.includes(license) || licenseRef.test(license))) {
    return refuse("license", "license", `is one of ${allowedLicenses.join(", ")}, or LicenseRef-<name>`)
  }
  const compatibility = fields.compatibility
  if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length > 500)) {
    return refuse("metadata", "compatibility", "is at most 500 characters")
  }
  const allowedTools = fields["allowed-tools"]
  if (allowedTools !== undefined && typeof allowedTools !== "string") {
    return refuse("metadata", "allowed-tools", "is a space-separated string")
  }
  if (
    metadata !== undefined &&
    (typeof metadata !== "object" || metadata === null || Array.isArray(metadata) ||
      Object.values(metadata).some((value) => typeof value !== "string"))
  ) {
    return refuse("metadata", "metadata", "maps names to strings")
  }
  const entries = (metadata ?? {}) as Record<string, string>
  if (entries.adapted === "true" && (!entries.source || !entries.revision)) {
    return refuse("provenance", "metadata", "an adapted skill records metadata.source and metadata.revision")
  }
  return Result.succeed({
    name,
    description,
    license,
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    metadata: Object.freeze({ ...entries }),
    body: split.body,
    revision: sha256Hex(text),
    path
  })
}

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/**
 * The pack revision of a set of skills.
 *
 * @category constructors
 * @since 1.0.0
 */
export const revisionOf = (skills: Iterable<Skill>): string =>
  canonicalDigest(
    [...skills].map((skill) => ({ name: skill.name, revision: skill.revision })).sort((left, right) =>
      compare(left.name, right.name)
    )
  )

/**
 * Loads every `<dir>/<skill>/SKILL.md`.
 *
 * Every non-hidden directory directly inside `dir` is a skill and must hold a
 * `SKILL.md`; files beside them (a notice, a pin list) are ignored. Each
 * directory and file must resolve inside the real path of `dir`.
 *
 * @category loading
 * @since 1.0.0
 */
export const loadPack = (dir: string): Effect.Effect<Pack, SkillsError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const readError = (relative: string, message: string) => new SkillsError({ code: "read", path: relative, message })
    const realRoot = yield* fs.realPath(path.resolve(dir)).pipe(
      Effect.mapError(() => readError(".", "the pack directory could not be resolved"))
    )
    const confined = (relative: string, location: string) =>
      fs.realPath(location).pipe(
        Effect.mapError(() => readError(relative, "could not be resolved")),
        Effect.flatMap((real) =>
          real.startsWith(realRoot + path.sep)
            ? Effect.succeed(real)
            : Effect.fail(
              new SkillsError({ code: "confinement", path: relative, message: "resolves outside the pack" })
            )
        )
      )
    const names = yield* fs.readDirectory(realRoot).pipe(Effect.mapError(() => readError(".", "could not be listed")))
    const skills: Array<Skill> = []
    for (const name of names.filter((entry) => !entry.startsWith(".")).sort(compare)) {
      const directory = yield* confined(name, path.join(realRoot, name))
      const info = yield* fs.stat(directory).pipe(Effect.mapError(() => readError(name, "could not be read")))
      if (info.type !== "Directory") continue
      const relative = `${name}/SKILL.md`
      const location = path.join(directory, "SKILL.md")
      const exists = yield* fs.exists(location).pipe(Effect.mapError(() => readError(relative, "could not be checked")))
      if (!exists) return yield* readError(relative, "a skill directory holds a SKILL.md")
      const file = yield* confined(relative, location)
      const size = yield* fs.stat(file).pipe(Effect.mapError(() => readError(relative, "could not be read")))
      if (size.type !== "File") return yield* readError(relative, "is not a regular file")
      if (Number(size.size) > maxSkillBytes) {
        return yield* new SkillsError({ code: "too-large", path: relative, message: `is over ${maxSkillBytes} bytes` })
      }
      const text = yield* fs.readFileString(file).pipe(Effect.mapError(() => readError(relative, "could not be read")))
      skills.push(yield* Effect.fromResult(parseSkill(name, text)))
    }
    return { revision: revisionOf(skills), skills: new Map(skills.map((skill) => [skill.name, skill])) }
  })

/**
 * The prompt texts for `names`, in that order, pinned at their revisions.
 *
 * @category conversions
 * @since 1.0.0
 */
export const select = (
  pack: Pack,
  names: ReadonlyArray<string>
): Result.Result<ReadonlyArray<Prompt.SkillText>, SkillsError> => {
  const selected: Array<Prompt.SkillText> = []
  for (const name of names) {
    const skill = pack.skills.get(name)
    if (skill === undefined) {
      return Result.fail(new SkillsError({ code: "missing", path: `${name}/SKILL.md`, message: "is not in the pack" }))
    }
    selected.push({ name: skill.name, revision: skill.revision, text: skill.body })
  }
  return Result.succeed(selected)
}
