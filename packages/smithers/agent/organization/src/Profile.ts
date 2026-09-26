/**
 * Role profiles: who a principal is, what it may touch, and what it returns.
 *
 * A profile is the complete, journal-safe description of one organization
 * principal. It names the principal and its manager, pins a model seat and a
 * versioned charter, and states every authority the principal holds as
 * {@link Grants}: tools, provider connections and containers, wiki knowledge,
 * repositories, personal-account access, how it may contact the owner, and
 * whether and how far it may hire. Budgets, a private memory namespace,
 * curated skills, and evaluation cases complete it. Identities are reference
 * names resolved by the host's credential broker, never secrets.
 *
 * {@link TaskContract} is what a principal is asked to do and
 * {@link RoleResult} is the one static schema every role task returns; the
 * role-specific part lives in `fields` and is checked against the charter's
 * declared output names by `Roster.validateResult`.
 *
 * Every schema here is a `Schema.Struct` decoded with
 * `Schema.decodeUnknownEffect`, and unknown keys are refused by the decoders
 * this module exports.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema"
import * as KnowledgePath from "./internal/knowledgePath.ts"

const pattern = (regex: RegExp, expected: string) => Schema.isPattern(regex, { expected })

const refuse = <T>(predicate: (value: T) => boolean, message: string) =>
  Schema.makeFilter<T>((value) => (predicate(value) ? message : undefined))

const unique = <T>(key: (value: T) => string, what: string) =>
  Schema.makeFilter<ReadonlyArray<T>>((values) =>
    new Set(values.map(key)).size === values.length ? undefined : `${what} must be unique`
  )

/**
 * Longest principal id, so the default memory bank `agent-<id>` stays within
 * the memory package's 128-character bank-name bound.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxPrincipalIdLength = 120

/**
 * A principal id: a lowercase core role id, optionally followed by up to
 * three dot-separated hire slugs (`lead.competitor-research`). `owner` is
 * reserved for the human the organization works for.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PrincipalId = Schema.String.check(
  pattern(/^[a-z][a-z0-9-]{0,62}(\.[a-z][a-z0-9-]{0,62}){0,3}$/, "a lowercase principal id"),
  Schema.isMaxLength(maxPrincipalIdLength),
  refuse<string>((id) => id === "owner", "owner is a reserved principal id")
)

/**
 * A principal id.
 *
 * @category models
 * @since 1.0.0
 */
export type PrincipalId = typeof PrincipalId.Type

/**
 * The owner, or a principal: who a profile reports to or a task came from.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Superior = Schema.Union([Schema.Literal("owner"), PrincipalId])

/**
 * The owner, or a principal.
 *
 * @category models
 * @since 1.0.0
 */
export type Superior = typeof Superior.Type

/**
 * `core` roles are authored by people; `specialist` (persistent) and
 * `helper` (task-scoped) principals are hired by another principal.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Kind = Schema.Literals(["core", "specialist", "helper"])

/**
 * A profile kind.
 *
 * @category models
 * @since 1.0.0
 */
export type Kind = typeof Kind.Type

/**
 * Lifecycle status. Only `active` principals act; `retired` is terminal.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Status = Schema.Literals(["proposed", "active", "paused", "retired"])

/**
 * A lifecycle status.
 *
 * @category models
 * @since 1.0.0
 */
export type Status = typeof Status.Type

/**
 * How a principal may reach the owner, strongest first: `owner-direct`
 * (unprompted, the assistant only), `via-assistant` (through the assistant,
 * or directly under a host-issued meeting or owner-thread receipt), and
 * `via-parent` (only through the principal that hired it).
 *
 * @category schemas
 * @since 1.0.0
 */
export const Contact = Schema.Literals(["owner-direct", "via-assistant", "via-parent"])

/**
 * A contact rule.
 *
 * @category models
 * @since 1.0.0
 */
export type Contact = typeof Contact.Type

/**
 * Tool families a principal may be given. Omitting one gives the principal
 * no binding for it at all.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Tool = Schema.Literals(["workspace", "memory", "retrieval", "wiki-read", "wiki-write", "delegate"])

/**
 * A tool family.
 *
 * @category models
 * @since 1.0.0
 */
export type Tool = typeof Tool.Type

/**
 * Provider access on a connection.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Access = Schema.Literals(["read", "write", "read-write"])

/**
 * Provider access on a connection.
 *
 * @category models
 * @since 1.0.0
 */
export type Access = typeof Access.Type

const tokenShaped = /^(?:xox[a-z]|sk)-/

/**
 * A reference name for a host-held connection or identity: lowercase words
 * joined by single hyphens, at most 63 characters. Values shaped like a
 * provider token are refused, because a reference is never the secret.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ReferenceName = Schema.String.check(
  pattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "a lowercase reference name"),
  Schema.isMaxLength(63),
  refuse<string>((name) => tokenShaped.test(name), "must be a reference name, not a credential")
)

/**
 * A provider container: a channel, repository, calendar, or `*` for all.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Container = Schema.String.check(
  pattern(/^\S(?:.*\S)?$/, "a container id without surrounding whitespace"),
  Schema.isMaxLength(256)
)

/**
 * Access to named containers through one configured provider connection.
 * `["*"]` means every container the connection reaches, and is only valid on
 * the owner-direct principal (checked by `Roster.validate`).
 *
 * @category schemas
 * @since 1.0.0
 */
export const ConnectionGrant = Schema.Struct({
  connection: ReferenceName,
  containers: Schema.Array(Container).check(
    unique<string>((container) => container, "containers"),
    refuse<ReadonlyArray<string>>(
      (containers) => containers.includes("*") && containers.length > 1,
      "a * container must be the only container"
    )
  ),
  access: Access
})

/**
 * Access to named containers through one connection.
 *
 * @category models
 * @since 1.0.0
 */
export type ConnectionGrant = typeof ConnectionGrant.Type

/**
 * A wiki knowledge grant: an exact relative file (`Org/Roles/a.md`) or a
 * subtree ending in `/` (`Org/Playbooks/`). Globs, `.` and `..`, hidden
 * segments, absolute paths, empty segments, backslashes, colons, control
 * characters, and non-NFC text are refused.
 *
 * @category schemas
 * @since 1.0.0
 */
export const KnowledgeGrant = Schema.String.check(
  Schema.makeFilter<string>((text) => {
    const parsed = KnowledgePath.parse(text)
    return parsed.ok ? undefined : `must be a relative file or subtree path (${parsed.refusal})`
  })
)

/**
 * A wiki knowledge grant.
 *
 * @category models
 * @since 1.0.0
 */
export type KnowledgeGrant = typeof KnowledgeGrant.Type

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const positive = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * How far a principal may hire: `maxDepth` levels below itself,
 * `maxChildren` unretired direct hires, of which at most `maxPersistent` are
 * specialists (helpers are task-scoped).
 *
 * @category schemas
 * @since 1.0.0
 */
export const HiringLimits = Schema.Struct({
  maxDepth: count,
  maxChildren: count,
  maxPersistent: count
})

/**
 * Hiring limits.
 *
 * @category models
 * @since 1.0.0
 */
export type HiringLimits = typeof HiringLimits.Type

/**
 * A public domain name in lowercase, such as `nodejs.org`. In a retrieval
 * grant it covers the domain and every subdomain.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Domain = Schema.String.check(
  pattern(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
    "a lowercase domain name such as example.com"
  ),
  Schema.isMaxLength(253)
)

/**
 * Where `retrieval` may reach on the public web. `allow`, when present,
 * limits it to those domains; `deny` removes domains. Each entry covers its
 * subdomains. Private, loopback, and link-local addresses are never
 * reachable, whatever the grant says.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RetrievalScope = Schema.Struct({
  allow: Schema.optionalKey(Schema.Array(Domain).check(unique<string>((domain) => domain, "allowed domains"))),
  deny: Schema.optionalKey(Schema.Array(Domain).check(unique<string>((domain) => domain, "denied domains")))
})

/**
 * Where `retrieval` may reach.
 *
 * @category models
 * @since 1.0.0
 */
export type RetrievalScope = typeof RetrievalScope.Type

/**
 * Every authority a principal holds. Anything not listed is not granted.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Grants = Schema.Struct({
  tools: Schema.Array(Tool).check(unique<string>((tool) => tool, "tools")),
  connections: Schema.Array(ConnectionGrant),
  knowledge: Schema.Array(KnowledgeGrant).check(unique<string>((path) => path, "knowledge grants")),
  repositories: Schema.Array(Container).check(unique<string>((repository) => repository, "repositories")),
  personalAccounts: Schema.Boolean,
  contact: Contact,
  hiring: Schema.optionalKey(HiringLimits),
  retrieval: Schema.optionalKey(RetrievalScope)
})

/**
 * Every authority a principal holds.
 *
 * @category models
 * @since 1.0.0
 */
export type Grants = typeof Grants.Type

/**
 * Standing spend and parallelism limits for one principal.
 *
 * @category schemas
 * @since 1.0.0
 */
export const BudgetPolicy = Schema.Struct({
  tokensPerTask: positive,
  tasksPerDay: positive,
  concurrency: positive,
  usdPerMonth: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)))
})

/**
 * Standing spend and parallelism limits.
 *
 * @category models
 * @since 1.0.0
 */
export type BudgetPolicy = typeof BudgetPolicy.Type

/**
 * A non-empty single line of text with no surrounding whitespace.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Line = Schema.String.check(
  pattern(/^[^\s](?:[^\r\n]*[^\s])?$/, "one non-empty line without surrounding whitespace"),
  Schema.isMaxLength(2000)
)

/**
 * A non-empty paragraph with no surrounding whitespace; it may span lines.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Paragraph = Schema.String.check(
  pattern(/^\S(?:[\s\S]*\S)?$/, "non-empty text without surrounding whitespace"),
  Schema.isMaxLength(8000)
)

/**
 * The name of one declared output field: a letter, then letters, digits,
 * `_`, or `-`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const FieldName = Schema.String.check(pattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "an output field name"))

/**
 * One output field a role returns in `RoleResult.fields`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const OutputField = Schema.Struct({ name: FieldName, description: Line })

/**
 * One declared output field.
 *
 * @category models
 * @since 1.0.0
 */
export type OutputField = typeof OutputField.Type

/**
 * A role's charter: its objective, the work and inputs it owns, what it may
 * do, what it returns and proves, when it escalates, how success is judged,
 * and its boundaries.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Charter = Schema.Struct({
  objective: Paragraph,
  responsibilities: Schema.NonEmptyArray(Line),
  inputs: Schema.NonEmptyArray(Line),
  allowedActions: Schema.NonEmptyArray(Line),
  output: Schema.Struct({
    fields: Schema.NonEmptyArray(OutputField),
    evidence: Schema.NonEmptyArray(Line)
  }),
  escalation: Schema.NonEmptyArray(Line),
  successCriteria: Schema.NonEmptyArray(Line),
  boundaries: Schema.Array(Line)
})

/**
 * A role's charter.
 *
 * @category models
 * @since 1.0.0
 */
export type Charter = typeof Charter.Type

/**
 * A skill or evaluation-case name: lowercase words joined by single hyphens,
 * 1 to 64 characters (the Agent Skills name rule).
 *
 * @category schemas
 * @since 1.0.0
 */
export const SkillName = Schema.String.check(
  pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a lowercase hyphenated name"),
  Schema.isMaxLength(64)
)

/**
 * A memory bank name, in the memory package's `<kind>-<id>` spelling.
 *
 * @category schemas
 * @since 1.0.0
 */
export const BankName = Schema.String.check(
  pattern(/^(?:flow|agent|user|global)-[a-z0-9][a-z0-9.-]*$/, "a memory bank name such as agent-<id>"),
  Schema.isMaxLength(128)
)

// `Date.parse` rolls an impossible day such as February 30 into March, so the
// instant must print back to the same date and time.
const isCalendarInstant = (text: string): boolean => {
  const millis = Date.parse(text)
  return !Number.isNaN(millis) && new Date(millis).toISOString().slice(0, 19) === text.slice(0, 19)
}

/**
 * A UTC instant in ISO 8601 form (`2026-09-25T17:00:00Z`, optional
 * milliseconds).
 *
 * @category schemas
 * @since 1.0.0
 */
export const Instant = Schema.String.check(
  pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, "a UTC ISO 8601 instant"),
  refuse<string>((text) => !isCalendarInstant(text), "must be a real calendar instant")
)

/**
 * A semantic version `major.minor.patch`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Version = Schema.String.check(
  pattern(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, "a major.minor.patch version")
)

/**
 * A model seat id (`provider:model` or a host alias), resolved by the host.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Seat = Schema.String.check(pattern(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/, "a model seat id"))

/**
 * A task identifier.
 *
 * @category schemas
 * @since 1.0.0
 */
export const TaskId = Schema.String.check(pattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, "a task id"))

/**
 * A complete role profile.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Profile = Schema.Struct({
  id: PrincipalId,
  name: Line,
  kind: Kind,
  status: Status,
  version: Version,
  reportsTo: Superior,
  seat: Seat,
  effort: Schema.optionalKey(Schema.Literals(["low", "medium", "high"])),
  charter: Charter,
  grants: Grants,
  budget: BudgetPolicy,
  memory: Schema.Struct({ namespace: BankName }),
  skills: Schema.Array(SkillName).check(unique<string>((name) => name, "skills")),
  cases: Schema.Array(SkillName).check(unique<string>((name) => name, "cases")),
  identities: Schema.Struct({
    slack: Schema.optionalKey(ReferenceName),
    email: Schema.optionalKey(ReferenceName),
    github: Schema.optionalKey(ReferenceName)
  }),
  meeting: Schema.optionalKey(Schema.Struct({ weekly: Schema.Boolean })),
  hiredBy: Schema.optionalKey(PrincipalId),
  hiredAt: Schema.optionalKey(Instant),
  retiredAt: Schema.optionalKey(Instant),
  taskScope: Schema.optionalKey(TaskId)
})

/**
 * A complete role profile.
 *
 * @category models
 * @since 1.0.0
 */
export type Profile = typeof Profile.Type

/**
 * The default private memory bank for a principal: `agent-<id>`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const defaultMemoryNamespace = (id: PrincipalId): string => `agent-${id}`

/**
 * One thing a principal is asked to do.
 *
 * @category schemas
 * @since 1.0.0
 */
export const TaskContract = Schema.Struct({
  id: TaskId,
  objective: Paragraph,
  inputs: Schema.Array(Line),
  acceptance: Schema.Array(Line),
  evidence: Schema.Array(Line),
  deadline: Schema.optionalKey(Instant),
  budgetTokens: Schema.optionalKey(positive),
  requestedBy: Superior,
  conversation: Schema.optionalKey(Schema.Struct({
    provider: Schema.NonEmptyString,
    container: Schema.NonEmptyString,
    thread: Schema.NonEmptyString
  }))
})

/**
 * One thing a principal is asked to do.
 *
 * @category models
 * @since 1.0.0
 */
export type TaskContract = typeof TaskContract.Type

/**
 * One piece of evidence a role result cites.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Evidence = Schema.Struct({
  kind: Schema.Literals(["file", "command", "url", "record", "note"]),
  ref: Schema.NonEmptyString,
  detail: Schema.String
})

/**
 * One piece of evidence.
 *
 * @category models
 * @since 1.0.0
 */
export type Evidence = typeof Evidence.Type

/**
 * The one output schema every role task returns.
 *
 * `done` is a claim of completion that must carry evidence and every declared
 * output field; `blocked`, `needs-decision`, and `declined` return control
 * with a reason.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RoleResult = Schema.Struct({
  status: Schema.Literals(["done", "blocked", "needs-decision", "declined"]),
  summary: Schema.NonEmptyString,
  fields: Schema.Record(Schema.String, Schema.Json),
  evidence: Schema.Array(Evidence),
  handoffs: Schema.Array(Schema.Struct({
    to: PrincipalId,
    objective: Schema.NonEmptyString,
    inputs: Schema.Array(Schema.String)
  })),
  escalations: Schema.Array(Schema.Struct({
    to: Schema.Literals(["assistant", "parent", "owner"]),
    reason: Schema.NonEmptyString
  })),
  decisions: Schema.Array(Schema.Struct({
    question: Schema.NonEmptyString,
    options: Schema.Array(Schema.String)
  }))
})

/**
 * The one output schema every role task returns.
 *
 * @category models
 * @since 1.0.0
 */
export type RoleResult = typeof RoleResult.Type

const strict = { onExcessProperty: "error" } as const

/**
 * Decodes an unknown value as a {@link Profile}, refusing unknown keys.
 *
 * @category decoding
 * @since 1.0.0
 */
export const decodeProfile = Schema.decodeUnknownEffect(Profile, strict)

/**
 * Decodes an unknown value as {@link Grants}, refusing unknown keys.
 *
 * @category decoding
 * @since 1.0.0
 */
export const decodeGrants = Schema.decodeUnknownEffect(Grants, strict)

/**
 * Decodes an unknown value as a {@link TaskContract}, refusing unknown keys.
 *
 * @category decoding
 * @since 1.0.0
 */
export const decodeTaskContract = Schema.decodeUnknownEffect(TaskContract, strict)

/**
 * Decodes an unknown value as a {@link RoleResult}, refusing unknown keys.
 *
 * @category decoding
 * @since 1.0.0
 */
export const decodeRoleResult = Schema.decodeUnknownEffect(RoleResult, strict)
