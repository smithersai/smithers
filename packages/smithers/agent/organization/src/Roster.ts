/**
 * Role profile files, the loaded roster, and its invariants.
 *
 * A profile file is Markdown. Its YAML frontmatter holds every profile field
 * except the charter, with exactly the keys {@link Profile.Profile} declares;
 * the body's `## Objective`, `## Responsibilities`, `## Inputs`,
 * `## Allowed actions`, `## Output`, `## Evidence`, `## Escalation`,
 * `## Success criteria`, and `## Boundaries` sections are the charter. The
 * objective is a paragraph, every other section a `- ` bullet list, and an
 * output bullet reads `name — description`. {@link parseProfile} and
 * {@link renderProfile} are inverses: rendering a parsed profile and parsing
 * it again yields the same profile and the same text.
 *
 * {@link load} reads `<dir>/Roles/*.md` (core roles, authored by people) and
 * `<dir>/Specialists/*.md` (hired principals) without recursing, confining
 * every read to the real path of `dir` so a symlink cannot pull a file in
 * from elsewhere. A file's name must be its profile id. The roster revision
 * is the SHA-256 of the canonical JSON of the profiles and each source file's
 * digest, so a host can pin exactly what it loaded.
 *
 * {@link validate} reports every organization invariant a roster breaks, and
 * {@link validateResult} checks a role's result against its charter. Errors
 * name the file and field; they never repeat a field's value.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Document, isMap, isSeq, type Node as YamlNode } from "yaml"
import * as Grants from "./Grants.ts"
import { canonicalDigest, sha256Hex } from "./internal/digest.ts"
import * as Frontmatter from "./internal/frontmatter.ts"
import * as Issues from "./internal/issues.ts"
import * as Profile from "./Profile.ts"

/**
 * Stable roster loading and parsing failure codes.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RosterErrorCode = Schema.Literals([
  "read",
  "confinement",
  "too-large",
  "frontmatter",
  "schema",
  "body",
  "file-name",
  "placement",
  "duplicate"
])

/**
 * A roster loading or parsing failure code.
 *
 * @category models
 * @since 1.0.0
 */
export type RosterErrorCode = typeof RosterErrorCode.Type

/**
 * A profile file that could not be read or parsed. `path` is relative to the
 * roster directory when the file was found by {@link load}; `field` names the
 * frontmatter field or body section. The message never contains a value.
 *
 * @category errors
 * @since 1.0.0
 */
export class RosterError extends Schema.TaggedError<RosterError>()("@smthrs/organization/Roster/RosterError", {
  code: RosterErrorCode,
  path: Schema.String,
  field: Schema.optionalKey(Schema.String),
  message: Schema.String
}) {}

/**
 * The largest profile file {@link load} reads.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxProfileBytes = 262_144

type SectionKey =
  | "objective"
  | "responsibilities"
  | "inputs"
  | "allowedActions"
  | "output"
  | "evidence"
  | "escalation"
  | "successCriteria"
  | "boundaries"

const sections: ReadonlyArray<readonly [SectionKey, string]> = [
  ["objective", "Objective"],
  ["responsibilities", "Responsibilities"],
  ["inputs", "Inputs"],
  ["allowedActions", "Allowed actions"],
  ["output", "Output"],
  ["evidence", "Evidence"],
  ["escalation", "Escalation"],
  ["successCriteria", "Success criteria"],
  ["boundaries", "Boundaries"]
]

const headingKey = new Map(sections.map(([key, heading]) => [heading, key]))

const outputSeparator = " — "

const bodyError = (path: string, field: string, message: string) =>
  new RosterError({ code: "body", path, field, message })

const bullets = (
  path: string,
  heading: string,
  lines: ReadonlyArray<string>
): Result.Result<Array<string>, RosterError> => {
  const items: Array<string> = []
  for (const line of lines) {
    if (line.trim().length === 0) continue
    if (line.startsWith("- ")) {
      items.push(line.slice(2).trim())
    } else if (/^\s{2,}\S/.test(line) && items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`
    } else {
      return Result.fail(bodyError(path, `## ${heading}`, "expected a \"- \" bullet list"))
    }
  }
  return Result.succeed(items)
}

const parseCharter = (path: string, body: string): Result.Result<Record<string, unknown>, RosterError> =>
  Result.gen(function*() {
    const found = new Map<SectionKey, Array<string>>()
    let current: Array<string> | undefined
    for (const line of body.split("\n")) {
      const heading = /^#{1,6}\s/.test(line) ? /^## (.+?)\s*$/.exec(line) : undefined
      if (heading === null) return yield* Result.fail(bodyError(path, line.trim(), "only ## section headings are used"))
      if (heading !== undefined) {
        const key = headingKey.get(heading[1]!)
        if (key === undefined) {
          return yield* Result.fail(bodyError(path, `## ${heading[1]}`, "is not a charter section"))
        }
        if (found.has(key)) return yield* Result.fail(bodyError(path, `## ${heading[1]}`, "appears twice"))
        current = []
        found.set(key, current)
      } else if (current !== undefined) {
        current.push(line)
      } else if (line.trim().length > 0) {
        return yield* Result.fail(bodyError(path, "body", "text must follow a ## section heading"))
      }
    }
    const lists: Partial<Record<SectionKey, Array<string>>> = {}
    for (const [key, heading] of sections) {
      const lines = found.get(key)
      if (lines === undefined) {
        if (key === "boundaries") {
          lists[key] = []
          continue
        }
        return yield* Result.fail(bodyError(path, `## ${heading}`, "is required"))
      }
      if (key !== "objective") lists[key] = yield* bullets(path, heading, lines)
    }
    const fields: Array<{ name: string; description: string }> = []
    for (const item of lists.output!) {
      const at = item.indexOf(outputSeparator)
      if (at <= 0) {
        return yield* Result.fail(bodyError(path, "## Output", `each bullet reads "name${outputSeparator}description"`))
      }
      fields.push({ name: item.slice(0, at).trim(), description: item.slice(at + outputSeparator.length).trim() })
    }
    return {
      objective: found.get("objective")!.join("\n").trim(),
      responsibilities: lists.responsibilities,
      inputs: lists.inputs,
      allowedActions: lists.allowedActions,
      output: { fields, evidence: lists.evidence },
      escalation: lists.escalation,
      successCriteria: lists.successCriteria,
      boundaries: lists.boundaries
    }
  })

const schemaError = (path: string, error: Schema.SchemaError) => {
  const problems = Issues.problems(error)
  return new RosterError({
    code: "schema",
    path,
    // Every schema issue names at least one field, the root included.
    field: problems[0]!.field,
    message: Issues.summary(problems)
  })
}

/**
 * Parses one profile file. `path` is only used to name the file in errors.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseProfile = (path: string, text: string): Effect.Effect<Profile.Profile, RosterError> =>
  Effect.gen(function*() {
    const normalized = text.replace(/\r\n?/g, "\n")
    const split = Frontmatter.split(normalized)
    if (split.frontmatter === undefined) {
      return yield* new RosterError({ code: "frontmatter", path, message: "a profile starts with --- frontmatter" })
    }
    const parsed = Frontmatter.parse(split.frontmatter, "core")
    if (!parsed.ok) return yield* new RosterError({ code: "frontmatter", path, message: parsed.error })
    if ("charter" in parsed.value) {
      return yield* new RosterError({
        code: "schema",
        path,
        field: "charter",
        message: "charter is the document body, not a frontmatter key"
      })
    }
    const charter = yield* Effect.fromResult(parseCharter(path, split.body))
    const id = parsed.value.id
    const candidate = {
      ...parsed.value,
      ...(parsed.value.memory === undefined && typeof id === "string"
        ? { memory: { namespace: Profile.defaultMemoryNamespace(id) } }
        : {}),
      charter
    }
    return yield* Profile.decodeProfile(candidate).pipe(Effect.mapError((error) => schemaError(path, error)))
  })

const frontmatterOf = (profile: Profile.Profile): Record<string, unknown> => {
  const { charter: _charter, grants, ...rest } = profile
  const ordered: Record<string, unknown> = {
    id: rest.id,
    name: rest.name,
    kind: rest.kind,
    status: rest.status,
    version: rest.version,
    reportsTo: rest.reportsTo,
    seat: rest.seat,
    ...(rest.effort === undefined ? {} : { effort: rest.effort }),
    grants: {
      tools: grants.tools,
      connections: grants.connections.map((grant) => ({
        connection: grant.connection,
        containers: grant.containers,
        access: grant.access
      })),
      knowledge: grants.knowledge,
      repositories: grants.repositories,
      personalAccounts: grants.personalAccounts,
      contact: grants.contact,
      ...(grants.hiring === undefined ? {} : {
        hiring: {
          maxDepth: grants.hiring.maxDepth,
          maxChildren: grants.hiring.maxChildren,
          maxPersistent: grants.hiring.maxPersistent
        }
      })
    },
    budget: {
      tokensPerTask: rest.budget.tokensPerTask,
      tasksPerDay: rest.budget.tasksPerDay,
      concurrency: rest.budget.concurrency,
      ...(rest.budget.usdPerMonth === undefined ? {} : { usdPerMonth: rest.budget.usdPerMonth })
    },
    memory: { namespace: rest.memory.namespace },
    skills: rest.skills,
    cases: rest.cases,
    identities: {
      ...(rest.identities.slack === undefined ? {} : { slack: rest.identities.slack }),
      ...(rest.identities.email === undefined ? {} : { email: rest.identities.email }),
      ...(rest.identities.github === undefined ? {} : { github: rest.identities.github })
    },
    ...(rest.meeting === undefined ? {} : { meeting: { weekly: rest.meeting.weekly } }),
    ...(rest.hiredBy === undefined ? {} : { hiredBy: rest.hiredBy }),
    ...(rest.hiredAt === undefined ? {} : { hiredAt: rest.hiredAt }),
    ...(rest.retiredAt === undefined ? {} : { retiredAt: rest.retiredAt }),
    ...(rest.taskScope === undefined ? {} : { taskScope: rest.taskScope })
  }
  return ordered
}

const flowStyle = (node: unknown): void => {
  if (isSeq(node) || isMap(node)) (node as YamlNode & { flow?: boolean }).flow = true
}

/**
 * Renders a profile as a profile file: canonical frontmatter key order, flow
 * style for short collections, and the charter sections in their fixed
 * order. `Boundaries` is omitted when empty.
 *
 * @category rendering
 * @since 1.0.0
 */
export const renderProfile = (profile: Profile.Profile): string => {
  const document = new Document(frontmatterOf(profile))
  for (
    const path of [
      ["grants", "tools"],
      ["grants", "knowledge"],
      ["grants", "repositories"],
      ["grants", "hiring"],
      ["budget"],
      ["memory"],
      ["skills"],
      ["cases"],
      ["identities"],
      ["meeting"]
    ]
  ) {
    flowStyle(document.getIn(path, true))
  }
  for (const index of profile.grants.connections.keys()) {
    flowStyle(document.getIn(["grants", "connections", index], true))
  }
  const frontmatter = document.toString({ lineWidth: 0, flowCollectionPadding: false })
  const charter = profile.charter
  const list = (items: ReadonlyArray<string>) => items.map((item) => `- ${item}`).join("\n")
  const blocks: Array<string> = [
    `## Objective\n\n${charter.objective}`,
    `## Responsibilities\n\n${list(charter.responsibilities)}`,
    `## Inputs\n\n${list(charter.inputs)}`,
    `## Allowed actions\n\n${list(charter.allowedActions)}`,
    `## Output\n\n${list(charter.output.fields.map((field) => `${field.name}${outputSeparator}${field.description}`))}`,
    `## Evidence\n\n${list(charter.output.evidence)}`,
    `## Escalation\n\n${list(charter.escalation)}`,
    `## Success criteria\n\n${list(charter.successCriteria)}`,
    ...(charter.boundaries.length === 0 ? [] : [`## Boundaries\n\n${list(charter.boundaries)}`])
  ]
  return `---\n${frontmatter}---\n\n${blocks.join("\n\n")}\n`
}

/**
 * One loaded profile file: its path relative to the roster directory and the
 * SHA-256 of its text.
 *
 * @category models
 * @since 1.0.0
 */
export interface Source {
  readonly path: string
  readonly digest: string
}

/**
 * A loaded roster: profiles by id (in id order), the files they came from,
 * and the revision that pins both.
 *
 * @category models
 * @since 1.0.0
 */
export interface Roster {
  readonly revision: string
  readonly profiles: ReadonlyMap<Profile.PrincipalId, Profile.Profile>
  readonly sources: ReadonlyArray<Source>
}

/**
 * The revision of a set of profiles and sources: SHA-256 over the canonical
 * JSON of the profiles in id order and the sources in path order.
 *
 * @category constructors
 * @since 1.0.0
 */
export const revisionOf = (
  profiles: Iterable<Profile.Profile>,
  sources: ReadonlyArray<Source>
): string =>
  canonicalDigest({
    profiles: [...profiles].sort((left, right) => compare(left.id, right.id)),
    sources: [...sources].sort((left, right) => compare(left.path, right.path))
  })

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/**
 * Builds a roster value from profiles and their sources.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (profiles: Iterable<Profile.Profile>, sources: ReadonlyArray<Source>): Roster => {
  const sorted = [...profiles].sort((left, right) => compare(left.id, right.id))
  return {
    revision: revisionOf(sorted, sources),
    profiles: new Map(sorted.map((profile) => [profile.id, profile])),
    sources: [...sources].sort((left, right) => compare(left.path, right.path))
  }
}

const directories = [
  { name: "Roles", required: true, core: true },
  { name: "Specialists", required: false, core: false }
] as const

/**
 * Loads `<dir>/Roles/*.md` and `<dir>/Specialists/*.md`.
 *
 * Only `.md` files directly inside those directories are read, `README.md`
 * is ignored, and files are read in name order. `Roles` must exist and hold
 * core profiles; `Specialists` may be absent and holds hired ones. Each
 * directory and file must resolve, through any symlinks, inside the real path
 * of `dir`, must be a regular file of at most {@link maxProfileBytes}, and
 * must be named `<id>.md`. The result is not validated; call
 * {@link validate}.
 *
 * @category loading
 * @since 1.0.0
 */
export const load = (dir: string): Effect.Effect<Roster, RosterError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const readError = (relative: string, message: string) => new RosterError({ code: "read", path: relative, message })
    const realRoot = yield* fs.realPath(path.resolve(dir)).pipe(
      Effect.mapError(() => readError(".", "the roster directory could not be resolved"))
    )
    // `join` keeps exactly one separator, so a root of `/` is its own prefix.
    const inside = (candidate: string) => candidate === realRoot || candidate.startsWith(path.join(realRoot, path.sep))
    const profiles = new Map<string, Profile.Profile>()
    const sources: Array<Source> = []
    for (const directory of directories) {
      const location = path.join(realRoot, directory.name)
      const exists = yield* fs.exists(location).pipe(
        Effect.mapError(() => readError(directory.name, "the directory could not be checked"))
      )
      if (!exists) {
        if (directory.required) return yield* readError(directory.name, "the directory does not exist")
        continue
      }
      const realDirectory = yield* fs.realPath(location).pipe(
        Effect.mapError(() => readError(directory.name, "the directory could not be resolved"))
      )
      if (!inside(realDirectory)) {
        return yield* new RosterError({
          code: "confinement",
          path: directory.name,
          message: "the directory resolves outside the roster directory"
        })
      }
      const names = yield* fs.readDirectory(realDirectory).pipe(
        Effect.mapError(() => readError(directory.name, "the directory could not be listed"))
      )
      for (const name of names.filter((entry) => entry.endsWith(".md") && entry !== "README.md").sort(compare)) {
        const relative = `${directory.name}/${name}`
        const real = yield* fs.realPath(path.join(realDirectory, name)).pipe(
          Effect.mapError(() => readError(relative, "the file could not be resolved"))
        )
        if (!inside(real)) {
          return yield* new RosterError({
            code: "confinement",
            path: relative,
            message: "the file resolves outside the roster directory"
          })
        }
        const info = yield* fs.stat(real).pipe(Effect.mapError(() => readError(relative, "the file could not be read")))
        if (info.type !== "File") return yield* readError(relative, "is not a regular file")
        if (Number(info.size) > maxProfileBytes) {
          return yield* new RosterError({
            code: "too-large",
            path: relative,
            message: `profiles are at most ${maxProfileBytes} bytes`
          })
        }
        const text = yield* fs.readFileString(real).pipe(
          Effect.mapError(() => readError(relative, "the file could not be read"))
        )
        const profile = yield* parseProfile(relative, text)
        if (name !== `${profile.id}.md`) {
          return yield* new RosterError({
            code: "file-name",
            path: relative,
            field: "id",
            message: "a profile file is named <id>.md"
          })
        }
        if ((profile.kind === "core") !== directory.core) {
          return yield* new RosterError({
            code: "placement",
            path: relative,
            field: "kind",
            message: "Roles holds core profiles and Specialists holds hired ones"
          })
        }
        if (profiles.has(profile.id)) {
          return yield* new RosterError({
            code: "duplicate",
            path: relative,
            field: "id",
            message: "another profile file has the same id"
          })
        }
        profiles.set(profile.id, profile)
        sources.push({ path: relative, digest: sha256Hex(text) })
      }
    }
    return make(profiles.values(), sources)
  })

/**
 * Stable roster invariant codes.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ViolationCode = Schema.Literals([
  "duplicate-id",
  "unknown-manager",
  "reporting-cycle",
  "assistant-missing",
  "assistant-multiple",
  "assistant-shape",
  "owner-direct-not-assistant",
  "hired-personal",
  "hire-record",
  "specialist-prefix",
  "unknown-hirer",
  "parent-inactive",
  "hiring-not-granted",
  "grants-widen",
  "depth-exceeded",
  "children-exceeded",
  "persistent-exceeded",
  "budget-exceeded",
  "task-scope",
  "weekly-meeting",
  "unknown-skill",
  "duplicate-output-field",
  "wildcard-container",
  "duplicate-memory-namespace",
  "retirement",
  "missing-field",
  "undeclared-field",
  "missing-evidence",
  "invalid-profile"
])

/**
 * A roster invariant code.
 *
 * @category models
 * @since 1.0.0
 */
export type ViolationCode = typeof ViolationCode.Type

/**
 * One broken invariant. `principal` is the profile the violation is about,
 * or empty for an organization-wide violation.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Violation = Schema.Struct({
  code: ViolationCode,
  principal: Schema.String,
  message: Schema.String
})

/**
 * One broken invariant.
 *
 * @category models
 * @since 1.0.0
 */
export type Violation = typeof Violation.Type

/**
 * Organization policy the roster is validated against: whether every active
 * core role needs a weekly meeting, and the skill names in the pinned pack.
 *
 * @category models
 * @since 1.0.0
 */
export interface Policy {
  readonly weeklyMeeting: boolean
  readonly skills: ReadonlyArray<string>
}

const violation = (code: ViolationCode, principal: string, message: string): Violation => ({
  code,
  principal,
  message
})

/**
 * Whether a profile was hired (`specialist` or `helper`).
 *
 * @category predicates
 * @since 1.0.0
 */
export const isHired = (profile: Profile.Profile): boolean => profile.kind !== "core"

/**
 * The daily token allocation of a budget: tokens per task times tasks per day.
 *
 * @category budgets
 * @since 1.0.0
 */
export const dailyTokens = (budget: Profile.BudgetPolicy): number => budget.tokensPerTask * budget.tasksPerDay

/**
 * The unretired principals `parent` hired directly.
 *
 * @category queries
 * @since 1.0.0
 */
export const childrenOf = (
  profiles: Iterable<Profile.Profile>,
  parent: Profile.PrincipalId
): ReadonlyArray<Profile.Profile> =>
  [...profiles].filter((profile) => profile.hiredBy === parent && profile.status !== "retired")

/**
 * A principal followed by every principal up its hiring chain, nearest
 * first. The chain stops at a core profile, a missing hirer, or a repeat.
 *
 * @category queries
 * @since 1.0.0
 */
export const hireChain = (
  profiles: ReadonlyMap<string, Profile.Profile>,
  id: Profile.PrincipalId
): ReadonlyArray<Profile.Profile> => {
  const chain: Array<Profile.Profile> = []
  let current = profiles.get(id)
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current)
    current = current.hiredBy === undefined ? undefined : profiles.get(current.hiredBy)
  }
  return chain
}

/**
 * Resolves the principal that may act as `id`: it exists and it and every
 * principal up its hiring chain are active. Hosts call this at every
 * dispatch with their pinned roster, so pausing or retiring a parent stops
 * its hires even when a task carries an older copy of their profile.
 *
 * @category queries
 * @since 1.0.0
 */
export const resolveActive = (
  roster: Pick<Roster, "profiles">,
  id: string
): Result.Result<Profile.Profile, Grants.Denied> => {
  const profile = roster.profiles.get(id)
  if (profile === undefined) {
    return Result.fail(
      new Grants.Denied({ reason: "unknown-principal", message: `principal ${id} is not on the roster` })
    )
  }
  const chain = hireChain(roster.profiles, id)
  const last = chain[chain.length - 1]!
  if (last.hiredBy !== undefined) {
    return Result.fail(new Grants.Denied({ reason: "inactive", message: `principal ${id} has no active hiring chain` }))
  }
  for (const link of chain) {
    if (link.status !== "active") {
      return Result.fail(
        new Grants.Denied({
          reason: "inactive",
          message: link === profile
            ? `principal ${id} is ${link.status}`
            : `principal ${id}'s hirer ${link.id} is ${link.status}`
        })
      )
    }
  }
  return Result.succeed(profile)
}

const declaredFieldDuplicates = (profile: Profile.Profile): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const field of profile.charter.output.fields) {
    if (seen.has(field.name)) duplicates.add(field.name)
    seen.add(field.name)
  }
  return [...duplicates]
}

const retirementViolations = (profile: Profile.Profile): ReadonlyArray<Violation> => {
  if (profile.status !== "retired") {
    return profile.retiredAt === undefined ? [] : [
      violation("retirement", profile.id, "only a retired profile carries retiredAt")
    ]
  }
  const grants = profile.grants
  const holds = grants.tools.length > 0 || grants.connections.length > 0 || grants.knowledge.length > 0 ||
    grants.repositories.length > 0 || grants.personalAccounts || grants.hiring !== undefined ||
    grants.contact !== "via-parent"
  return [
    ...(profile.retiredAt === undefined
      ? [violation("retirement", profile.id, "a retired profile carries retiredAt")]
      : []),
    ...(holds ? [violation("retirement", profile.id, "a retired profile holds no grants")] : [])
  ]
}

const hiredViolations = (
  profile: Profile.Profile,
  byId: ReadonlyMap<string, Profile.Profile>
): ReadonlyArray<Violation> => {
  const found: Array<Violation> = []
  if (!isHired(profile)) {
    if (profile.hiredBy !== undefined || profile.hiredAt !== undefined || profile.taskScope !== undefined) {
      found.push(violation("hire-record", profile.id, "a core profile carries no hiredBy, hiredAt, or taskScope"))
    }
    return found
  }
  if (profile.grants.personalAccounts || profile.grants.contact === "owner-direct") {
    found.push(
      violation("hired-personal", profile.id, "a hired principal holds no personal accounts or owner-direct contact")
    )
  }
  if (profile.kind === "helper" && profile.taskScope === undefined) {
    found.push(violation("task-scope", profile.id, "a helper is scoped to one task"))
  }
  if (profile.kind === "specialist" && profile.taskScope !== undefined) {
    found.push(violation("task-scope", profile.id, "a specialist is persistent and carries no taskScope"))
  }
  if (profile.hiredBy === undefined || profile.hiredAt === undefined) {
    found.push(violation("hire-record", profile.id, "a hired profile carries hiredBy and hiredAt"))
    return found
  }
  const hirer = profile.hiredBy
  if (!profile.id.startsWith(`${hirer}.`) || profile.id.slice(hirer.length + 1).includes(".")) {
    found.push(violation("specialist-prefix", profile.id, `a hired id is ${hirer}.<slug>`))
  }
  if (profile.reportsTo !== hirer) {
    found.push(violation("hire-record", profile.id, "a hired principal reports to its hirer"))
  }
  const parent = byId.get(hirer)
  if (parent === undefined) {
    found.push(violation("unknown-hirer", profile.id, `hirer ${hirer} is not on the roster`))
    return found
  }
  if (profile.status === "retired") return found
  if (parent.status === "retired") {
    found.push(violation("parent-inactive", profile.id, `hirer ${hirer} is retired`))
    return found
  }
  if (parent.grants.hiring === undefined) {
    found.push(violation("hiring-not-granted", profile.id, `hirer ${hirer} may not hire`))
  }
  for (const widening of Grants.widenings(profile.grants, parent.grants)) {
    found.push(violation("grants-widen", profile.id, `${widening.grant}: ${widening.detail}`))
  }
  const chain = hireChain(byId, profile.id)
  for (let index = 1; index < chain.length; index++) {
    const ancestor = chain[index]!
    const limit = ancestor.grants.hiring?.maxDepth ?? 0
    // A direct hirer without hiring limits is already reported above.
    if (index > limit && ancestor.status !== "retired" && (index > 1 || ancestor.grants.hiring !== undefined)) {
      found.push(violation("depth-exceeded", profile.id, `${index} levels below ${ancestor.id}, which allows ${limit}`))
    }
  }
  return found
}

const parentViolations = (
  profile: Profile.Profile,
  profiles: ReadonlyArray<Profile.Profile>
): ReadonlyArray<Violation> => {
  const children = childrenOf(profiles, profile.id)
  if (children.length === 0) return []
  const found: Array<Violation> = []
  const limits = profile.grants.hiring ?? { maxDepth: 0, maxChildren: 0, maxPersistent: 0 }
  if (children.length > limits.maxChildren) {
    found.push(
      violation("children-exceeded", profile.id, `${children.length} hires exceed maxChildren ${limits.maxChildren}`)
    )
  }
  const persistent = children.filter((child) => child.kind === "specialist").length
  if (persistent > limits.maxPersistent) {
    found.push(
      violation(
        "persistent-exceeded",
        profile.id,
        `${persistent} specialists exceed maxPersistent ${limits.maxPersistent}`
      )
    )
  }
  found.push(...budgetViolations(profile, children))
  return found
}

const budgetViolations = (
  parent: Profile.Profile,
  children: ReadonlyArray<Profile.Profile>
): ReadonlyArray<Violation> => {
  const found: Array<Violation> = []
  const tokens = children.reduce((sum, child) => sum + dailyTokens(child.budget), 0)
  if (tokens > dailyTokens(parent.budget)) {
    found.push(
      violation("budget-exceeded", parent.id, `hires allocate ${tokens} daily tokens of ${dailyTokens(parent.budget)}`)
    )
  }
  const usd = parent.budget.usdPerMonth
  if (usd !== undefined) {
    if (children.some((child) => child.budget.usdPerMonth === undefined)) {
      found.push(violation("budget-exceeded", parent.id, "every hire of a USD-capped principal declares usdPerMonth"))
    } else {
      const spent = children.reduce((sum, child) => sum + child.budget.usdPerMonth!, 0)
      if (spent > usd) found.push(violation("budget-exceeded", parent.id, `hires allocate ${spent} USD of ${usd}`))
    }
  }
  return found
}

/**
 * Every invariant `profiles` breaks under `policy`, in profile order, then
 * organization-wide ones. Empty means the roster is valid.
 *
 * Checked: unique ids and memory namespaces; `reportsTo` resolves without a
 * cycle; exactly one principal holds personal accounts, and it is the single
 * `owner-direct` principal, an active unhired core role; hired principals
 * never hold either, carry a hire record, are named `<hirer>.<slug>`, report
 * to their hirer, stay inside its grants, and respect every ancestor's
 * depth, children, persistent, and budget limits; helpers carry a task
 * scope and specialists do not; `*` containers only on the `owner-direct`
 * principal; retired profiles hold no grants; weekly meetings when the
 * policy requires them; skills from the pinned pack; unique output fields.
 *
 * @category validation
 * @since 1.0.0
 */
export const validate = (profiles: ReadonlyArray<Profile.Profile>, policy: Policy): ReadonlyArray<Violation> => {
  const found: Array<Violation> = []
  const byId = new Map<string, Profile.Profile>()
  const namespaces = new Map<string, string>()
  const skills = new Set(policy.skills)
  for (const profile of profiles) {
    if (byId.has(profile.id)) {
      found.push(violation("duplicate-id", profile.id, "another profile has the same id"))
    } else {
      byId.set(profile.id, profile)
    }
  }
  for (const profile of profiles) {
    if (profile.reportsTo !== "owner" && !byId.has(profile.reportsTo)) {
      found.push(violation("unknown-manager", profile.id, `reportsTo ${profile.reportsTo} is not on the roster`))
    } else if (reportsInCycle(profile, byId)) {
      found.push(violation("reporting-cycle", profile.id, "the reporting chain returns to this profile"))
    }
    const owner = namespaces.get(profile.memory.namespace)
    if (owner !== undefined && owner !== profile.id) {
      found.push(violation("duplicate-memory-namespace", profile.id, `memory namespace is also used by ${owner}`))
    } else {
      namespaces.set(profile.memory.namespace, profile.id)
    }
    found.push(...hiredViolations(profile, byId))
    found.push(...parentViolations(profile, profiles))
    found.push(...retirementViolations(profile))
    if (
      profile.grants.contact !== "owner-direct" &&
      profile.grants.connections.some((grant) => grant.containers.includes("*"))
    ) {
      found.push(violation("wildcard-container", profile.id, "only the owner-direct principal holds * containers"))
    }
    if (
      policy.weeklyMeeting && profile.kind === "core" && profile.status === "active" && profile.meeting?.weekly !== true
    ) {
      found.push(violation("weekly-meeting", profile.id, "every active core role has a weekly meeting"))
    }
    for (const skill of profile.skills) {
      if (!skills.has(skill)) {
        found.push(violation("unknown-skill", profile.id, `skill ${skill} is not in the pinned pack`))
      }
    }
    for (const name of declaredFieldDuplicates(profile)) {
      found.push(violation("duplicate-output-field", profile.id, `output field ${name} is declared twice`))
    }
  }
  found.push(...assistantViolations(profiles))
  return found
}

const reportsInCycle = (profile: Profile.Profile, byId: ReadonlyMap<string, Profile.Profile>): boolean => {
  let current: Profile.Profile | undefined = profile
  for (let step = 0; step <= byId.size; step++) {
    current = current.reportsTo === "owner" ? undefined : byId.get(current.reportsTo)
    if (current === undefined) return false
    if (current === profile) return true
  }
  return false
}

const assistantViolations = (profiles: ReadonlyArray<Profile.Profile>): ReadonlyArray<Violation> => {
  const found: Array<Violation> = []
  const personal = profiles.filter((profile) => profile.grants.personalAccounts)
  const assistants = personal.filter((profile) => profile.kind === "core" && profile.status === "active")
  if (assistants.length === 0) {
    found.push(violation("assistant-missing", "", "exactly one active core profile holds personal accounts"))
  }
  for (const extra of personal.filter((profile) => profile !== assistants[0])) {
    found.push(violation("assistant-multiple", extra.id, "only the assistant holds personal accounts"))
  }
  const assistant = assistants[0]
  if (assistant !== undefined && (assistant.grants.contact !== "owner-direct" || assistant.hiredBy !== undefined)) {
    found.push(
      violation("assistant-shape", assistant.id, "the assistant is an unhired core role with owner-direct contact")
    )
  }
  for (const profile of profiles) {
    if (profile.grants.contact === "owner-direct" && profile !== assistant) {
      found.push(violation("owner-direct-not-assistant", profile.id, "only the assistant contacts the owner directly"))
    }
  }
  return found
}

/**
 * Checks a role's result against its charter: every field name is declared,
 * and a `done` result carries every declared field and at least one piece of
 * evidence. Empty means the result is acceptable.
 *
 * @category validation
 * @since 1.0.0
 */
export const validateResult = (profile: Profile.Profile, result: Profile.RoleResult): ReadonlyArray<Violation> => {
  const declared = new Set(profile.charter.output.fields.map((field) => field.name))
  const found: Array<Violation> = []
  for (const name of Object.keys(result.fields)) {
    if (!declared.has(name)) {
      found.push(violation("undeclared-field", profile.id, `field ${name} is not in the charter`))
    }
  }
  if (result.status === "done") {
    for (const name of declared) {
      if (!Object.hasOwn(result.fields, name)) {
        found.push(violation("missing-field", profile.id, `missing field ${name}`))
      }
    }
    if (result.evidence.length === 0) {
      found.push(violation("missing-evidence", profile.id, "missing evidence"))
    }
  }
  return found
}
