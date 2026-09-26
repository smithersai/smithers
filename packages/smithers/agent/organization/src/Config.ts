/**
 * The organization's configuration pages, parsed from the private wiki.
 *
 * Four Markdown pages configure a host. Each keeps its settings in YAML
 * frontmatter and its explanation for people in the body, which the host
 * never reads:
 *
 * - `Org/Organization.md` — {@link Organization}: owner and assistant, where
 *   the roster, skills, cases, and the other pages live, model seats, the VM
 *   defaults, spending limits, and generated-output settings;
 * - `Org/Policy/Gates.md` — a `Gates.GatePolicy`. Only Approval and Review
 *   gates run; a policy naming another kind is refused here with a
 *   not-yet-supported error rather than loaded and ignored;
 * - `Org/Connections.md` — {@link Connections}: provider connections by
 *   credential reference name only. A token-shaped reference is refused;
 * - `Org/Meetings.md` — {@link Meetings}: the weekly one-on-one inputs, `null`
 *   until the owner sets them.
 *
 * Unknown keys are refused. An error names the page and the field and says
 * what the field expects; it never repeats a value, because a page can hold a
 * pasted secret in the wrong place.
 *
 * {@link load} reads the pages the organization page names, relative to the
 * wiki root and confined to its real path.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Gates from "./Gates.ts"
import * as Frontmatter from "./internal/frontmatter.ts"
import * as Issues from "./internal/issues.ts"
import * as KnowledgePath from "./internal/knowledgePath.ts"
import * as Meeting from "./Meetings.ts"
import * as Profile from "./Profile.ts"

/**
 * Stable configuration failure codes.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ConfigErrorCode = Schema.Literals([
  "read",
  "confinement",
  "too-large",
  "frontmatter",
  "schema",
  "unsupported"
])

/**
 * A configuration failure code.
 *
 * @category models
 * @since 1.0.0
 */
export type ConfigErrorCode = typeof ConfigErrorCode.Type

/**
 * A configuration page that could not be read or was refused. `path` is the
 * page, relative to the wiki root when {@link load} found it; `field` names
 * the frontmatter field. The message never contains a value.
 *
 * @category errors
 * @since 1.0.0
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()("@smthrs/organization/Config/ConfigError", {
  code: ConfigErrorCode,
  path: Schema.String,
  field: Schema.optionalKey(Schema.String),
  message: Schema.String
}) {}

/**
 * The largest configuration page {@link load} reads.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxPageBytes = 262_144

/**
 * A wiki path relative to the wiki root: no `..`, no hidden segments, no
 * absolute paths or globs. A trailing `/` is allowed on directories.
 *
 * @category schemas
 * @since 1.0.0
 */
export const WikiPath = Schema.String.check(
  Schema.makeFilter<string>((text) =>
    KnowledgePath.parse(text).ok ? undefined : "must be a relative wiki path without .., hidden segments, or globs"
  )
)

const Count = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const Text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

/**
 * Model seats by name. `default` is required; profiles pin their own.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Seats = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/, { expected: "a lowercase seat name" })),
  Profile.Seat
).check(
  Schema.makeFilter<Readonly<Record<string, string>>>((seats) =>
    Object.hasOwn(seats, "default") ? undefined : "must name a default seat"
  )
)

/**
 * The organization page: `Org/Organization.md`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Organization = Schema.Struct({
  organization: Schema.optionalKey(Profile.ReferenceName),
  version: Schema.optionalKey(Profile.Version),
  owner: Schema.Literal("owner"),
  assistant: Profile.PrincipalId,
  rosterDir: WikiPath,
  commonFile: Schema.optionalKey(WikiPath),
  skillsDir: Schema.optionalKey(WikiPath),
  casesDir: Schema.optionalKey(WikiPath),
  policyFile: Schema.optionalKey(WikiPath),
  connectionsFile: Schema.optionalKey(WikiPath),
  meetingsFile: Schema.optionalKey(WikiPath),
  weeklyMeeting: Schema.optionalKey(Schema.Boolean),
  seats: Seats,
  judge: Profile.Seat,
  vm: Schema.Struct({
    provider: Schema.Literal("microsandbox"),
    image: Schema.NullOr(Text(256)),
    cpus: Count(1, 64),
    memoryMib: Count(256, 1_048_576),
    maxConcurrentVMs: Count(1, 64),
    /** Guest networking for workspace and check machines. Default off. */
    network: Schema.optionalKey(Schema.Boolean)
  }),
  limits: Schema.optionalKey(Schema.Struct({
    usdPerMonth: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)))
  })),
  wiki: Schema.Struct({
    generatedDir: WikiPath,
    statusFile: WikiPath,
    commit: Schema.Boolean,
    push: Schema.Boolean
  })
})

/**
 * The organization page.
 *
 * @category models
 * @since 1.0.0
 */
export type Organization = typeof Organization.Type

const Alias = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, { expected: "an alias name" }))

/**
 * One provider connection, by reference. `credential` and `appCredential`
 * name secrets the host's credential broker holds; they are never the secret.
 * A `null` container alias is not yet mapped and is unusable.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Connection = Schema.Struct({
  id: Profile.ReferenceName,
  provider: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/, { expected: "a provider name" })),
  label: Schema.optionalKey(Text(200)),
  principal: Schema.optionalKey(Profile.PrincipalId),
  personal: Schema.Boolean,
  credential: Profile.ReferenceName,
  appCredential: Schema.optionalKey(Profile.ReferenceName),
  scopes: Schema.Array(Text(256)),
  appScopes: Schema.optionalKey(Schema.Array(Text(256))),
  containers: Schema.optionalKey(Schema.Array(Profile.Container)),
  containerAliases: Schema.optionalKey(Schema.Record(Alias, Schema.NullOr(Profile.Container))),
  status: Schema.optionalKey(Schema.Literals(["not-connected", "connected"]))
})

/**
 * One provider connection, by reference.
 *
 * @category models
 * @since 1.0.0
 */
export type Connection = typeof Connection.Type

/**
 * The connections page: `Org/Connections.md`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Connections = Schema.Struct({
  connections: Schema.Array(Connection).check(
    Schema.makeFilter<ReadonlyArray<Connection>>((connections) =>
      new Set(connections.map((connection) => connection.id)).size === connections.length
        ? undefined
        : "connection ids must be unique"
    )
  ),
  identities: Schema.optionalKey(Schema.Record(
    Profile.ReferenceName,
    Schema.Struct({
      address: Schema.NullOr(Text(320)),
      status: Schema.Literals(["not-provisioned", "provisioned"])
    })
  ))
})

/**
 * The connections page.
 *
 * @category models
 * @since 1.0.0
 */
export type Connections = typeof Connections.Type

/**
 * The meetings page: `Org/Meetings.md`. `timezone`, `start`, and `firstDate`
 * stay `null` until the owner sets them.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Meetings = Schema.Struct({
  seriesId: Meeting.SeriesId,
  weekday: Meeting.Weekday,
  slotMinutes: Count(1, 1440),
  order: Schema.Array(Profile.PrincipalId),
  timezone: Schema.NullOr(Text(64)),
  start: Schema.NullOr(Meeting.LocalTime),
  firstDate: Schema.NullOr(Meeting.LocalDate),
  calendarConnection: Schema.optionalKey(Profile.ReferenceName),
  slackDelivery: Schema.optionalKey(Text(200))
})

/**
 * The meetings page.
 *
 * @category models
 * @since 1.0.0
 */
export type Meetings = typeof Meetings.Type

/**
 * The weekly request the meetings page describes, or `undefined` while any
 * owner input is still `null`.
 *
 * @category combinators
 * @since 1.0.0
 */
export const weeklyRequest = (meetings: Meetings): Meeting.WeeklyRequest | undefined =>
  meetings.timezone === null || meetings.start === null || meetings.firstDate === null
    ? undefined
    : {
      seriesId: meetings.seriesId,
      timezone: meetings.timezone,
      weekday: meetings.weekday,
      start: meetings.start,
      slotMinutes: meetings.slotMinutes,
      order: meetings.order,
      firstDate: meetings.firstDate
    }

const strict = { onExcessProperty: "error" } as const

const frontmatterOf = (path: string, text: string): Effect.Effect<Record<string, unknown>, ConfigError> => {
  const split = Frontmatter.split(text.replace(/\r\n?/g, "\n"))
  if (split.frontmatter === undefined) {
    return Effect.fail(new ConfigError({ code: "frontmatter", path, message: "a page starts with --- frontmatter" }))
  }
  const parsed = Frontmatter.parse(split.frontmatter, "core")
  return parsed.ok
    ? Effect.succeed(parsed.value)
    : Effect.fail(new ConfigError({ code: "frontmatter", path, message: parsed.error }))
}

const decodePage = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema, strict)
  return (path: string, text: string): Effect.Effect<S["Type"], ConfigError> =>
    frontmatterOf(path, text).pipe(
      Effect.flatMap((value) =>
        decode(value).pipe(Effect.mapError((error) => {
          const problems = Issues.problems(error)
          return new ConfigError({
            code: "schema",
            path,
            // Every schema issue names at least one field, the root included.
            field: problems[0]!.field,
            message: Issues.summary(problems)
          })
        }))
      )
    )
}

/**
 * Parses the organization page. `path` only names the page in errors.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseOrganization: (path: string, text: string) => Effect.Effect<Organization, ConfigError> = decodePage(
  Organization
)

/**
 * Parses the connections page. `path` only names the page in errors.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseConnections: (path: string, text: string) => Effect.Effect<Connections, ConfigError> = decodePage(
  Connections
)

/**
 * Parses the meetings page. `path` only names the page in errors.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseMeetings: (path: string, text: string) => Effect.Effect<Meetings, ConfigError> = decodePage(
  Meetings
)

const decodePolicy = decodePage(Gates.GatePolicy)

/**
 * Parses the gate policy page, refusing any gate kind that cannot run yet.
 * `path` only names the page in errors.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseGatePolicy = (path: string, text: string): Effect.Effect<Gates.GatePolicy, ConfigError> =>
  Effect.flatMap(decodePolicy(path, text), (policy) => {
    const index = policy.gates.findIndex((gate) => Gates.unsupported(gate.spec) !== undefined)
    if (index === -1) return Effect.succeed(policy)
    return Effect.fail(
      new ConfigError({
        code: "unsupported",
        path,
        field: `gates[${index}].spec`,
        message: Gates.unsupported(policy.gates[index]!.spec)!
      })
    )
  })

/**
 * Everything the organization page names, loaded and checked. A page the
 * organization page does not name is `undefined`; with no `policyFile` the
 * policy is empty.
 *
 * @category models
 * @since 1.0.0
 */
export interface Loaded {
  readonly organization: Organization
  readonly policy: Gates.GatePolicy
  readonly connections: Connections | undefined
  readonly meetings: Meetings | undefined
}

/**
 * The organization page's default location under the wiki root.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultOrganizationFile = "Org/Organization.md"

/**
 * Reads and checks the organization page at `file` (relative to `root`) and
 * the policy, connections, and meetings pages it names. Every page must
 * resolve, through any symlinks, inside the real path of `root`, be a regular
 * file, and be at most {@link maxPageBytes}.
 *
 * @category loading
 * @since 1.0.0
 */
export const load = (
  root: string,
  file: string = defaultOrganizationFile
): Effect.Effect<Loaded, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const readError = (relative: string, message: string) => new ConfigError({ code: "read", path: relative, message })
    const realRoot = yield* fs.realPath(path.resolve(root)).pipe(
      Effect.mapError(() => readError(".", "the wiki root could not be resolved"))
    )
    // `join` keeps exactly one separator, so a root of `/` is its own prefix.
    const inside = (candidate: string) => candidate.startsWith(path.join(realRoot, path.sep))
    const read = (relative: string) =>
      Effect.gen(function*() {
        if (!KnowledgePath.parse(relative).ok) {
          return yield* new ConfigError({
            code: "confinement",
            path: relative,
            message: "is not a relative wiki path"
          })
        }
        const real = yield* fs.realPath(path.join(realRoot, relative)).pipe(
          Effect.mapError(() => readError(relative, "the page could not be resolved"))
        )
        if (!inside(real)) {
          return yield* new ConfigError({
            code: "confinement",
            path: relative,
            message: "the page resolves outside the wiki root"
          })
        }
        const info = yield* fs.stat(real).pipe(Effect.mapError(() => readError(relative, "the page could not be read")))
        if (info.type !== "File") return yield* readError(relative, "is not a regular file")
        if (Number(info.size) > maxPageBytes) {
          return yield* new ConfigError({
            code: "too-large",
            path: relative,
            message: `pages are at most ${maxPageBytes} bytes`
          })
        }
        return yield* fs.readFileString(real).pipe(
          Effect.mapError(() => readError(relative, "the page could not be read"))
        )
      })
    const organization = yield* Effect.flatMap(read(file), (text) => parseOrganization(file, text))
    const page = <A>(
      relative: string | undefined,
      parse: (path: string, text: string) => Effect.Effect<A, ConfigError>
    ): Effect.Effect<A | undefined, ConfigError> =>
      relative === undefined
        ? Effect.succeed(undefined)
        : Effect.flatMap(read(relative), (text) => parse(relative, text))
    return {
      organization,
      policy: (yield* page(organization.policyFile, parseGatePolicy)) ?? Gates.empty("none"),
      connections: yield* page(organization.connectionsFile, parseConnections),
      meetings: yield* page(organization.meetingsFile, parseMeetings)
    }
  })
