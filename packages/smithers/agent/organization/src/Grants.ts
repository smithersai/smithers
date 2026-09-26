/**
 * Pure authority decisions over role grants.
 *
 * Every question the host asks before it lets a principal act is answered
 * here from a profile and trusted host data, never from text a model or a
 * provider supplied:
 *
 * - {@link subsetOf} and {@link widenings} decide whether a hired child's
 *   grants stay inside its parent's. The relation is sound by construction:
 *   every tool, repository, container-and-access pair, and knowledge path a
 *   child grant reaches is reached by the parent, and a hired child never
 *   holds personal accounts or direct owner contact. A child of the
 *   assistant routes all contact through it.
 * - {@link canRead}, {@link canWrite}, {@link canResolveCredential}, and
 *   {@link canReadKnowledge} gate retrieved records, provider writes,
 *   credential resolution, and wiki reads. Personal connections resolve only
 *   for the assistant: the single active core principal with personal
 *   accounts and `owner-direct` contact.
 * - {@link canContactOwner} allows unprompted owner contact to the assistant
 *   alone. Anyone else needs a {@link ContactReceipt} minted in-process by a
 *   {@link ReceiptIssuer} for exactly that principal, destination, and time
 *   window. A receipt decoded from JSON, rebuilt from a payload, or copied
 *   field by field is not trusted, because only the issuer's own objects are.
 *
 * Every check requires an `active` principal and answers with a
 * `Result`, failing with a typed {@link Denied}.
 *
 * @since 1.0.0
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as KnowledgePath from "./internal/knowledgePath.ts"
import type * as Profile from "./Profile.ts"

/**
 * Why an authority check refused.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DeniedReason = Schema.Literals([
  "unknown-principal",
  "inactive",
  "tombstone",
  "unknown-connection",
  "personal-connection",
  "connection-not-granted",
  "container-not-granted",
  "access-not-granted",
  "knowledge-not-granted",
  "invalid-path",
  "not-assistant",
  "via-parent",
  "no-receipt",
  "untrusted-receipt",
  "receipt-principal",
  "receipt-destination",
  "receipt-window",
  "invalid-receipt"
])

/**
 * Why an authority check refused.
 *
 * @category models
 * @since 1.0.0
 */
export type DeniedReason = typeof DeniedReason.Type

/**
 * A refused authority check.
 *
 * @category errors
 * @since 1.0.0
 */
export class Denied extends Schema.TaggedError<Denied>()("@smthrs/organization/Grants/Denied", {
  reason: DeniedReason,
  message: Schema.String
}) {}

const deny = (reason: DeniedReason, message: string): Result.Result<never, Denied> =>
  Result.fail(new Denied({ reason, message }))

const allow: Result.Result<void, Denied> = Result.succeed(undefined)

/**
 * One way a child's grants reach beyond its parent's.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Widening = Schema.Struct({
  grant: Schema.Literals([
    "tools",
    "connections",
    "knowledge",
    "repositories",
    "personalAccounts",
    "contact",
    "hiring"
  ]),
  detail: Schema.String
})

/**
 * One way a child's grants reach beyond its parent's.
 *
 * @category models
 * @since 1.0.0
 */
export type Widening = typeof Widening.Type

/**
 * Options for {@link widenings} and {@link subsetOf}.
 *
 * `hired` defaults to `true`, the strict relation: a hired child never holds
 * personal accounts or `owner-direct` contact, a child of an `owner-direct`
 * parent must use `via-parent`, and its hiring depth is one less than its
 * parent's.
 *
 * @category models
 * @since 1.0.0
 */
export interface SubsetOptions {
  readonly hired?: boolean
}

const contactRank: Record<Profile.Contact, number> = { "via-parent": 0, "via-assistant": 1, "owner-direct": 2 }

const bits = (access: Profile.Access): ReadonlyArray<"read" | "write"> =>
  access === "read-write" ? ["read", "write"] : [access]

const hasBit = (access: Profile.Access, bit: "read" | "write"): boolean => access === "read-write" || access === bit

const reaches = (grant: Profile.ConnectionGrant, container: string): boolean =>
  grant.containers.includes("*") || (container !== "*" && grant.containers.includes(container))

const parsedKnowledge = (grants: ReadonlyArray<string>): ReadonlyArray<KnowledgePath.KnowledgePath> =>
  grants.flatMap((grant) => {
    const parsed = KnowledgePath.parse(grant)
    return parsed.ok ? [parsed.path] : []
  })

/**
 * Every way `child` reaches beyond `parent`, in grant order. Empty means
 * `child` is a subset.
 *
 * @category relations
 * @since 1.0.0
 */
export const widenings = (
  child: Profile.Grants,
  parent: Profile.Grants,
  options: SubsetOptions = {}
): ReadonlyArray<Widening> => {
  const hired = options.hired ?? true
  const found: Array<Widening> = []
  for (const tool of child.tools) {
    if (!parent.tools.includes(tool)) {
      found.push({ grant: "tools", detail: `tool ${tool} is not granted to the parent` })
    }
  }
  for (const grant of child.connections) {
    for (const container of grant.containers) {
      for (const bit of bits(grant.access)) {
        const covered = parent.connections.some((held) =>
          held.connection === grant.connection && hasBit(held.access, bit) && reaches(held, container)
        )
        if (!covered) {
          found.push({
            grant: "connections",
            detail: `${bit} on ${grant.connection} container ${container} is not granted to the parent`
          })
        }
      }
    }
  }
  const parentKnowledge = parsedKnowledge(parent.knowledge)
  for (const text of child.knowledge) {
    const parsed = KnowledgePath.parse(text)
    if (!parsed.ok) {
      found.push({ grant: "knowledge", detail: `knowledge grant is outside the grammar (${parsed.refusal})` })
    } else if (!parentKnowledge.some((held) => KnowledgePath.covers(held, parsed.path))) {
      found.push({ grant: "knowledge", detail: `knowledge ${text} is not inside a parent grant` })
    }
  }
  for (const repository of child.repositories) {
    if (!parent.repositories.includes(repository)) {
      found.push({ grant: "repositories", detail: `repository ${repository} is not granted to the parent` })
    }
  }
  if (child.personalAccounts && (hired || !parent.personalAccounts)) {
    found.push({
      grant: "personalAccounts",
      detail: hired ? "a hired principal never holds personal accounts" : "the parent holds no personal accounts"
    })
  }
  if (contactRank[child.contact] > contactRank[parent.contact]) {
    found.push({ grant: "contact", detail: `${child.contact} is stronger than the parent's ${parent.contact}` })
  } else if (hired && child.contact === "owner-direct") {
    found.push({ grant: "contact", detail: "a hired principal never contacts the owner directly" })
  } else if (hired && parent.contact === "owner-direct" && child.contact !== "via-parent") {
    found.push({ grant: "contact", detail: "a principal hired by the assistant contacts the owner only through it" })
  }
  if (child.hiring !== undefined) {
    if (parent.hiring === undefined) {
      found.push({ grant: "hiring", detail: "the parent may not hire" })
    } else {
      const depth = hired ? parent.hiring.maxDepth - 1 : parent.hiring.maxDepth
      if (child.hiring.maxDepth > depth) found.push({ grant: "hiring", detail: `maxDepth exceeds ${depth}` })
      if (child.hiring.maxChildren > parent.hiring.maxChildren) {
        found.push({ grant: "hiring", detail: `maxChildren exceeds ${parent.hiring.maxChildren}` })
      }
      if (child.hiring.maxPersistent > parent.hiring.maxPersistent) {
        found.push({ grant: "hiring", detail: `maxPersistent exceeds ${parent.hiring.maxPersistent}` })
      }
    }
  }
  return found
}

/**
 * Whether `child`'s grants stay inside `parent`'s. See {@link widenings}.
 *
 * @category relations
 * @since 1.0.0
 */
export const subsetOf = (child: Profile.Grants, parent: Profile.Grants, options: SubsetOptions = {}): boolean =>
  widenings(child, parent, options).length === 0

/**
 * Whether a profile is the organization's assistant: an active core
 * principal, not hired, with personal accounts and `owner-direct` contact.
 * `Roster.validate` guarantees there is exactly one.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isAssistant = (principal: Profile.Profile): boolean =>
  principal.status === "active" &&
  principal.kind === "core" &&
  principal.hiredBy === undefined &&
  principal.grants.personalAccounts &&
  principal.grants.contact === "owner-direct"

const requireActive = (principal: Profile.Profile): Result.Result<void, Denied> =>
  principal.status === "active" ? allow : deny("inactive", `principal ${principal.id} is ${principal.status}`)

/**
 * The facts about one configured connection that authority depends on.
 * `@smthrs/integrations` connections satisfy it.
 *
 * @category models
 * @since 1.0.0
 */
export interface ConnectionFacts {
  readonly id: string
  readonly personal: boolean
}

const connectionFor = (
  principal: Profile.Profile,
  connection: string,
  connections: ReadonlyArray<ConnectionFacts>
): Result.Result<ConnectionFacts, Denied> => {
  const facts = connections.find((candidate) => candidate.id === connection)
  if (facts === undefined) return deny("unknown-connection", `connection ${connection} is not configured`)
  if (facts.personal && !isAssistant(principal)) {
    return deny("personal-connection", `connection ${connection} is personal and only the assistant may use it`)
  }
  return Result.succeed(facts)
}

const covering = (
  principal: Profile.Profile,
  connection: string,
  container: string,
  bit: "read" | "write"
): Result.Result<void, Denied> => {
  const named = principal.grants.connections.filter((grant) => grant.connection === connection)
  if (named.length === 0) {
    return deny("connection-not-granted", `principal ${principal.id} holds no grant on ${connection}`)
  }
  const reached = named.filter((grant) => reaches(grant, container))
  if (reached.length === 0) {
    return deny("container-not-granted", `principal ${principal.id} holds no grant on ${connection} for ${container}`)
  }
  return reached.some((grant) => hasBit(grant.access, bit))
    ? allow
    : deny("access-not-granted", `principal ${principal.id} may not ${bit} ${connection} ${container}`)
}

/**
 * The provenance facts of a retrieved record that reading it depends on.
 * `@smthrs/integrations` source records satisfy it.
 *
 * @category models
 * @since 1.0.0
 */
export interface RecordFacts {
  readonly connectionId: string
  readonly deleted: boolean
  readonly access: { readonly containerId: string | null }
  readonly thread: { readonly containerId: string | null }
}

/**
 * Whether a principal may read a retrieved record. Tombstones are never
 * readable, a personal connection's records only by the assistant, and the
 * record's container (its access container, else its thread container) must
 * be granted for read. A record naming no container is reachable only
 * through a `*` grant.
 *
 * @category checks
 * @since 1.0.0
 */
export const canRead = (
  principal: Profile.Profile,
  record: RecordFacts,
  connections: ReadonlyArray<ConnectionFacts>
): Result.Result<void, Denied> =>
  Result.gen(function*() {
    yield* requireActive(principal)
    if (record.deleted) return yield* deny("tombstone", "the record was deleted at its provider")
    yield* connectionFor(principal, record.connectionId, connections)
    const container = record.access.containerId ?? record.thread.containerId ?? "*"
    return yield* covering(principal, record.connectionId, container, "read")
  })

/**
 * Whether a principal may write to a container through a connection.
 *
 * @category checks
 * @since 1.0.0
 */
export const canWrite = (
  principal: Profile.Profile,
  connection: string,
  container: string,
  connections: ReadonlyArray<ConnectionFacts>
): Result.Result<void, Denied> =>
  Result.gen(function*() {
    yield* requireActive(principal)
    yield* connectionFor(principal, connection, connections)
    return yield* covering(principal, connection, container, "write")
  })

/**
 * Whether the credential broker may resolve a connection's secret for a
 * principal: the connection is configured, granted to the principal, and
 * personal connections resolve only for the assistant.
 *
 * @category checks
 * @since 1.0.0
 */
export const canResolveCredential = (
  principal: Profile.Profile,
  connection: string,
  connections: ReadonlyArray<ConnectionFacts>
): Result.Result<void, Denied> =>
  Result.gen(function*() {
    yield* requireActive(principal)
    yield* connectionFor(principal, connection, connections)
    if (!principal.grants.connections.some((grant) => grant.connection === connection)) {
      return yield* deny("connection-not-granted", `principal ${principal.id} holds no grant on ${connection}`)
    }
  })

/**
 * Whether a principal's knowledge grants cover a wiki file path. The path
 * must itself be inside the grant grammar: relative, normalized, no dot
 * segments.
 *
 * @category checks
 * @since 1.0.0
 */
export const canReadKnowledge = (principal: Profile.Profile, path: string): Result.Result<void, Denied> =>
  Result.gen(function*() {
    yield* requireActive(principal)
    const parsed = KnowledgePath.parse(path)
    if (!parsed.ok || parsed.path.kind !== "file") {
      return yield* deny(
        "invalid-path",
        `wiki path is not a relative file path (${parsed.ok ? "subtree" : parsed.refusal})`
      )
    }
    if (!parsedKnowledge(principal.grants.knowledge).some((grant) => KnowledgePath.covers(grant, parsed.path))) {
      return yield* deny("knowledge-not-granted", `principal ${principal.id} has no knowledge grant for ${path}`)
    }
  })

/**
 * A host-issued permission for one principal to contact the owner at one
 * destination during one window: a meeting occurrence (`one-on-one`) or a
 * thread the owner started (`owner-thread`). Only objects minted by a
 * {@link ReceiptIssuer} are trusted.
 *
 * @category models
 * @since 1.0.0
 */
export interface ContactReceipt {
  readonly kind: "one-on-one" | "owner-thread"
  readonly principal: Profile.PrincipalId
  readonly destination: string
  readonly windowStartMs: number
  readonly windowEndMs: number
  readonly issuedBy: string
}

/**
 * The longest window one receipt may cover: a day. A scheduled meeting or an
 * owner-started thread is a bounded occasion, never a standing privilege.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxReceiptWindowMs = 86_400_000

/**
 * Mints trusted contact receipts. Hold one only in host code that has read the
 * meeting or conversation record the receipt attests to.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReceiptIssuer {
  readonly issuedBy: string
  readonly issue: (fields: Omit<ContactReceipt, "issuedBy">) => Result.Result<ContactReceipt, Denied>
}

const trusted = new WeakSet<ContactReceipt>()

/**
 * Creates a receipt issuer named `issuedBy`. Receipts it mints are frozen and
 * recorded as trusted for the life of the process; nothing decoded from data
 * can join them.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeReceiptIssuer = (issuedBy: string): ReceiptIssuer => ({
  issuedBy,
  issue: (fields) => {
    const window = fields.windowEndMs - fields.windowStartMs
    if (!Number.isFinite(window) || window <= 0 || window > maxReceiptWindowMs) {
      return deny("invalid-receipt", `a receipt window must be positive and at most ${maxReceiptWindowMs} ms`)
    }
    if (fields.destination.length === 0) return deny("invalid-receipt", "a receipt must name its destination")
    const receipt: ContactReceipt = Object.freeze({
      kind: fields.kind,
      principal: fields.principal,
      destination: fields.destination,
      windowStartMs: fields.windowStartMs,
      windowEndMs: fields.windowEndMs,
      issuedBy
    })
    trusted.add(receipt)
    return Result.succeed(receipt)
  }
})

/**
 * Where and when a principal wants to contact the owner.
 *
 * @category models
 * @since 1.0.0
 */
export interface ContactContext {
  readonly destination: string
  readonly nowMs: number
}

/**
 * Whether a principal may contact the owner at `context.destination` now.
 *
 * The assistant always may. A `via-parent` principal never may. A
 * `via-assistant` principal may only with a trusted receipt issued for it,
 * for this destination, whose window contains `context.nowMs`.
 *
 * @category checks
 * @since 1.0.0
 */
export const canContactOwner = (
  principal: Profile.Profile,
  receipt: ContactReceipt | undefined,
  context: ContactContext
): Result.Result<void, Denied> =>
  Result.gen(function*() {
    yield* requireActive(principal)
    switch (principal.grants.contact) {
      case "owner-direct":
        return isAssistant(principal)
          ? undefined
          : yield* deny("not-assistant", `principal ${principal.id} is not the assistant`)
      case "via-parent":
        return yield* deny("via-parent", `principal ${principal.id} reaches the owner only through its parent`)
    }
    if (receipt === undefined) {
      return yield* deny("no-receipt", `principal ${principal.id} needs a meeting or owner-thread receipt`)
    }
    if (!trusted.has(receipt)) return yield* deny("untrusted-receipt", "the receipt was not issued by this host")
    if (receipt.principal !== principal.id) {
      return yield* deny("receipt-principal", `the receipt was issued for ${receipt.principal}`)
    }
    if (receipt.destination !== context.destination) {
      return yield* deny("receipt-destination", "the receipt was issued for another destination")
    }
    if (context.nowMs < receipt.windowStartMs || context.nowMs >= receipt.windowEndMs) {
      return yield* deny("receipt-window", "the receipt's window does not contain now")
    }
  })
