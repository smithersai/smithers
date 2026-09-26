import * as Result from "effect/Result"
import { beforeAll, describe, expect, it } from "vitest"
import * as Grants from "../src/Grants.ts"
import * as KnowledgePath from "../src/internal/knowledgePath.ts"
import type * as Profile from "../src/Profile.ts"
import type * as Roster from "../src/Roster.ts"
import { err, loadExample, ok, prng, profileOf, withGrants } from "./support.ts"

const none: Profile.Grants = {
  tools: [],
  connections: [],
  knowledge: [],
  repositories: [],
  personalAccounts: false,
  contact: "via-parent"
}

const grants = (patch: Partial<Profile.Grants>): Profile.Grants => ({ ...none, ...patch })

// ---------------------------------------------------------------------------
// An independent semantic model of what a set of grants reaches. It is
// written from the grammar's meaning, not from the implementation, so the
// property tests below compare the relation against ground truth.
// ---------------------------------------------------------------------------

const allTools: ReadonlyArray<Profile.Tool> = [
  "workspace",
  "memory",
  "retrieval",
  "wiki-read",
  "wiki-write",
  "delegate"
]
const connectionNames = ["c1", "c2", "c3"]
const containerNames = ["A", "B", "C"]
const probeContainers = ["A", "B", "C", "D", "(none)"]
const repositoryNames = ["r1", "r2", "r3"]
const segments = ["a", "ab", "b"]
const probeSegments = ["a", "ab", "b", "x"]

const pathsOf = (alphabet: ReadonlyArray<string>, depth: number): Array<string> => {
  const out: Array<string> = []
  let level = [""]
  for (let d = 1; d <= depth; d++) {
    level = level.flatMap((prefix) => alphabet.map((segment) => (prefix === "" ? segment : `${prefix}/${segment}`)))
    out.push(...level)
  }
  return out
}

const probeFiles = pathsOf(probeSegments, 4)
const knowledgeUniverse = pathsOf(segments, 3).flatMap((path) => [path, `${path}/`])

const readableFiles = (knowledge: ReadonlyArray<string>): Set<string> =>
  new Set(
    probeFiles.filter((file) =>
      knowledge.some((grant) => grant === file || (grant.endsWith("/") && file.startsWith(grant)))
    )
  )

const capabilities = (g: Profile.Grants): Set<string> => {
  const out = new Set<string>()
  for (const tool of g.tools) out.add(`tool:${tool}`)
  for (const grant of g.connections) {
    const accessBits = grant.access === "read-write" ? ["read", "write"] : [grant.access]
    for (const bit of accessBits) {
      for (const probe of probeContainers) {
        // "*" reaches every container, including unnamed ones and records
        // that name no container; a named container reaches only itself.
        if (grant.containers.includes("*") || grant.containers.includes(probe)) {
          out.add(`conn:${grant.connection}:${bit}:${probe}`)
        }
      }
    }
  }
  for (const file of readableFiles(g.knowledge)) out.add(`file:${file}`)
  for (const repository of g.repositories) out.add(`repo:${repository}`)
  if (g.personalAccounts) out.add("personal")
  return out
}

const rank = { "via-parent": 0, "via-assistant": 1, "owner-direct": 2 } as const

const semanticallyInside = (child: Profile.Grants, parent: Profile.Grants): boolean => {
  const held = capabilities(parent)
  for (const capability of capabilities(child)) if (!held.has(capability)) return false
  if (child.personalAccounts) return false
  if (rank[child.contact] > rank[parent.contact] || child.contact === "owner-direct") return false
  if (parent.contact === "owner-direct" && child.contact !== "via-parent") return false
  if (child.hiring !== undefined) {
    if (parent.hiring === undefined) return false
    if (child.hiring.maxDepth > parent.hiring.maxDepth - 1) return false
    if (child.hiring.maxChildren > parent.hiring.maxChildren) return false
    if (child.hiring.maxPersistent > parent.hiring.maxPersistent) return false
  }
  return true
}

type Random = ReturnType<typeof prng>

const randomContainers = (random: Random): Array<string> =>
  random.chance(0.15) ? ["*"] : random.subset(containerNames, 0.5)

const randomGrants = (random: Random): Profile.Grants => ({
  tools: random.subset(allTools, 0.5),
  connections: Array.from({ length: random.int(4) }, () => ({
    connection: random.pick(connectionNames),
    containers: randomContainers(random),
    access: random.pick(["read", "write", "read-write"] as const)
  })),
  knowledge: [...new Set(Array.from({ length: random.int(4) }, () => random.pick(knowledgeUniverse)))],
  repositories: random.subset(repositoryNames, 0.5),
  personalAccounts: random.chance(0.2),
  contact: random.pick(["owner-direct", "via-assistant", "via-parent"] as const),
  ...(random.chance(0.6)
    ? { hiring: { maxDepth: random.int(4), maxChildren: random.int(4), maxPersistent: random.int(4) } }
    : {})
})

/** A child produced only by narrowing: always inside its parent. */
const narrowed = (random: Random, parent: Profile.Grants): Profile.Grants => {
  const connections = parent.connections.flatMap((grant) => {
    if (random.chance(0.3)) return []
    const containers = grant.containers.includes("*") && random.chance(0.5)
      ? random.subset(containerNames, 0.5)
      : random.subset(grant.containers, 0.7)
    const access = grant.access === "read-write" && random.chance(0.5)
      ? random.pick(["read", "write"] as const)
      : grant.access
    return [{ connection: grant.connection, containers, access }]
  })
  const knowledge = [
    ...new Set(parent.knowledge.flatMap((grant) => {
      if (random.chance(0.3)) return []
      if (grant.endsWith("/") && random.chance(0.5)) {
        const deeper = `${grant}${random.pick(segments)}`
        return [random.chance(0.5) ? deeper : `${deeper}/`]
      }
      return [grant]
    }))
  ]
  const contact = parent.contact === "owner-direct"
    ? "via-parent"
    : random.pick(
      parent.contact === "via-assistant" ? ["via-assistant", "via-parent"] as const : ["via-parent"] as const
    )
  const hiring = parent.hiring !== undefined && parent.hiring.maxDepth >= 1 && random.chance(0.5)
    ? {
      hiring: {
        maxDepth: random.int(parent.hiring.maxDepth),
        maxChildren: random.int(parent.hiring.maxChildren + 1),
        maxPersistent: random.int(parent.hiring.maxPersistent + 1)
      }
    }
    : {}
  return {
    tools: random.subset(parent.tools, 0.7),
    connections,
    knowledge,
    repositories: random.subset(parent.repositories, 0.7),
    personalAccounts: false,
    contact,
    ...hiring
  }
}

/** One random attempt to widen a child, including string-prefix tricks. */
const widen = (random: Random, child: Profile.Grants): Profile.Grants => {
  switch (random.int(9)) {
    case 0:
      return { ...child, tools: [...new Set([...child.tools, random.pick(allTools)])] }
    case 1:
      return {
        ...child,
        connections: [...child.connections, {
          connection: random.pick(connectionNames),
          containers: randomContainers(random),
          access: random.pick(["read", "write", "read-write"] as const)
        }]
      }
    case 2: {
      const base = random.pick(knowledgeUniverse)
      const trick = random.pick([
        base,
        base.endsWith("/") ? base.slice(0, -1) : `${base}/`,
        base.endsWith("/") ? `${base.slice(0, -1)}b/` : `${base}b`,
        base.split("/")[0]!,
        `${base.split("/")[0]}/`
      ])
      return { ...child, knowledge: [...new Set([...child.knowledge, trick])] }
    }
    case 3:
      return { ...child, repositories: [...new Set([...child.repositories, random.pick(repositoryNames)])] }
    case 4:
      return { ...child, personalAccounts: true }
    case 5:
      return { ...child, contact: random.pick(["owner-direct", "via-assistant"] as const) }
    case 6:
      return { ...child, hiring: { maxDepth: random.int(5), maxChildren: random.int(5), maxPersistent: random.int(5) } }
    case 7:
      return {
        ...child,
        connections: child.connections.map((grant) => ({ ...grant, access: "read-write" as const }))
      }
    default:
      return {
        ...child,
        connections: child.connections.map((grant) => ({ ...grant, containers: ["*"] }))
      }
  }
}

describe("Grants.subsetOf soundness", () => {
  it("never lets a subset reach anything its parent cannot (20,000 random pairs)", () => {
    const random = prng(0x5eed)
    let accepted = 0
    let refused = 0
    for (let trial = 0; trial < 20_000; trial++) {
      const parent = randomGrants(random)
      let child = narrowed(random, parent)
      for (let step = random.int(3); step > 0; step--) child = widen(random, child)
      const subset = Grants.subsetOf(child, parent)
      if (subset) {
        accepted++
        expect(semanticallyInside(child, parent), JSON.stringify({ child, parent })).toBe(true)
      } else {
        refused++
        expect(Grants.widenings(child, parent).length).toBeGreaterThan(0)
      }
    }
    // Both outcomes occur, so the property is not vacuous.
    expect(accepted).toBeGreaterThan(2_000)
    expect(refused).toBeGreaterThan(2_000)
  })

  it("accepts every child produced by narrowing alone", () => {
    const random = prng(42)
    for (let trial = 0; trial < 5_000; trial++) {
      const parent = randomGrants(random)
      const child = narrowed(random, parent)
      expect(Grants.widenings(child, parent), JSON.stringify({ child, parent })).toEqual([])
    }
  })

  it("is transitive: a grandchild inside a child inside a parent is inside the parent", () => {
    const random = prng(7)
    for (let trial = 0; trial < 3_000; trial++) {
      const parent = randomGrants(random)
      const child = narrowed(random, parent)
      const grandchild = narrowed(random, child)
      expect(Grants.subsetOf(grandchild, child)).toBe(true)
      expect(semanticallyInside(grandchild, parent)).toBe(true)
    }
  })

  it("decides knowledge containment exactly on an exhaustive small universe", () => {
    const parsed = knowledgeUniverse.map((text) => {
      const result = KnowledgePath.parse(text)
      if (!result.ok) throw new Error(text)
      return { text, path: result.path, files: readableFiles([text]) }
    })
    // Every probe file up to depth 4 plus one unseen segment decides whether
    // a subtree reaches further than its parent.
    for (const child of parsed) {
      for (const parent of parsed) {
        const semantic = [...child.files].every((file) => parent.files.has(file))
        expect(KnowledgePath.covers(parent.path, child.path), `${parent.text} ⊇ ${child.text}`).toBe(semantic)
      }
    }
  })

  it("never widens through path spellings outside the grammar", () => {
    const parent = grants({ knowledge: ["Org/Playbooks/", "Org/Roles/lead.md"] })
    for (
      const attempt of [
        "Org/Playbooks/../Secrets/",
        "Org/Playbooks/./x.md",
        "Org/Playbooks//x.md",
        "/Org/Playbooks/x.md",
        "Org/Playbooks/*",
        "Org/Playbooks/**/x.md",
        "Org/Playbooks/{a,b}.md",
        "Org/Playbooks/x?.md",
        "Org/Playbooks/[ab].md",
        "Org/Playbooks\\..\\Secrets.md",
        "C:/Org/Playbooks/x.md",
        "Org/Playbooks/.git/config",
        "Org/Play",
        "Org/Playbooks",
        "Org/PlaybooksExtra/",
        "Org/Roles/lead.md/",
        "Org/Roles/lead.md/x",
        "Org/Roles/lead.mdx",
        "Org/Roles/",
        " Org/Playbooks/x.md",
        "Org/Playbooks/x.md\u0000",
        "Org/Playbooks/cafe\u0301.md",
        ""
      ]
    ) {
      expect(Grants.subsetOf(grants({ knowledge: [attempt] }), parent), attempt).toBe(false)
    }
    expect(Grants.subsetOf(grants({ knowledge: ["Org/Playbooks/deploy/", "Org/Roles/lead.md"] }), parent)).toBe(true)
  })

  it("refuses long and deep paths", () => {
    expect(KnowledgePath.parse("a/".repeat(KnowledgePath.maxSegments + 1))).toEqual({ ok: false, refusal: "too-deep" })
    expect(KnowledgePath.parse("a".repeat(KnowledgePath.maxLength + 1))).toEqual({ ok: false, refusal: "too-long" })
    expect(KnowledgePath.parse("café/x.md").ok).toBe(true)
  })
})

describe("Grants.widenings", () => {
  const parent = grants({
    tools: ["memory", "retrieval"],
    connections: [
      { connection: "slack-team", containers: ["C1", "C2"], access: "read" },
      { connection: "slack-team", containers: ["C1"], access: "write" },
      { connection: "github", containers: ["*"], access: "read-write" }
    ],
    knowledge: ["Org/Playbooks/"],
    repositories: ["example/product"],
    contact: "via-assistant",
    hiring: { maxDepth: 2, maxChildren: 3, maxPersistent: 1 }
  })

  it("accepts access assembled from two parent grants on one connection", () => {
    const child = grants({ connections: [{ connection: "slack-team", containers: ["C1"], access: "read-write" }] })
    expect(Grants.widenings(child, parent)).toEqual([])
  })

  it("reports each way a child reaches further", () => {
    const child: Profile.Grants = {
      tools: ["memory", "workspace"],
      connections: [
        { connection: "slack-team", containers: ["C2"], access: "read-write" },
        { connection: "slack-other", containers: ["C1"], access: "read" },
        { connection: "slack-team", containers: ["*"], access: "read" }
      ],
      knowledge: ["Org/Playbooks/x.md", "Org/Secrets/", "../x"],
      repositories: ["example/product", "example/private"],
      personalAccounts: true,
      contact: "owner-direct",
      hiring: { maxDepth: 2, maxChildren: 4, maxPersistent: 2 }
    }
    expect(Grants.widenings(child, parent).map((widening) => widening.grant)).toEqual([
      "tools",
      "connections",
      "connections",
      "connections",
      "knowledge",
      "knowledge",
      "repositories",
      "personalAccounts",
      "contact",
      "hiring",
      "hiring",
      "hiring"
    ])
  })

  it("keeps hired principals away from personal accounts and direct contact", () => {
    const assistant = grants({ personalAccounts: true, contact: "owner-direct", hiring: parent.hiring! })
    expect(Grants.widenings(grants({ personalAccounts: true, contact: "via-parent" }), assistant)).toEqual([
      { grant: "personalAccounts", detail: "a hired principal never holds personal accounts" }
    ])
    expect(Grants.widenings(grants({ contact: "owner-direct" }), assistant)).toEqual([
      { grant: "contact", detail: "a hired principal never contacts the owner directly" }
    ])
    expect(Grants.widenings(grants({ contact: "via-assistant" }), assistant)).toEqual([
      { grant: "contact", detail: "a principal hired by the assistant contacts the owner only through it" }
    ])
    expect(Grants.subsetOf(grants({ contact: "via-parent" }), assistant)).toBe(true)
  })

  it("relaxes only the hired rules when hired is false", () => {
    const assistant = grants({ personalAccounts: true, contact: "owner-direct", hiring: parent.hiring! })
    const peer = grants({ personalAccounts: true, contact: "owner-direct", hiring: parent.hiring! })
    expect(Grants.subsetOf(peer, assistant, { hired: false })).toBe(true)
    expect(Grants.widenings(grants({ personalAccounts: true }), grants({}), { hired: false })).toEqual([
      { grant: "personalAccounts", detail: "the parent holds no personal accounts" }
    ])
    expect(Grants.widenings(grants({ hiring: { maxDepth: 1, maxChildren: 0, maxPersistent: 0 } }), grants({}))).toEqual(
      [
        { grant: "hiring", detail: "the parent may not hire" }
      ]
    )
  })
})

describe("Grants checks", () => {
  let roster: Roster.Roster
  let assistant: Profile.Profile
  let builder: Profile.Profile
  const connections: ReadonlyArray<Grants.ConnectionFacts> = [
    { id: "personal-calendar", personal: true },
    { id: "personal-mail", personal: true },
    { id: "slack-assistant", personal: false },
    { id: "slack-builder", personal: false },
    { id: "github-product", personal: false }
  ]
  const record = (patch: Partial<Grants.RecordFacts> = {}): Grants.RecordFacts => ({
    connectionId: "slack-builder",
    deleted: false,
    access: { containerId: "C0TEAM" },
    thread: { containerId: "C0TEAM" },
    ...patch
  })

  beforeAll(async () => {
    roster = await loadExample()
    assistant = profileOf(roster, "assistant")
    builder = profileOf(roster, "builder")
  })

  const reason = (result: Result.Result<void, Grants.Denied>) => err(result).reason

  it("identifies the assistant", () => {
    expect(Grants.isAssistant(assistant)).toBe(true)
    expect(Grants.isAssistant(builder)).toBe(false)
    expect(Grants.isAssistant({ ...assistant, status: "paused" })).toBe(false)
    expect(Grants.isAssistant({ ...assistant, kind: "specialist" })).toBe(false)
    expect(Grants.isAssistant({ ...assistant, hiredBy: "lead" })).toBe(false)
    expect(Grants.isAssistant(withGrants(assistant, { contact: "via-assistant" }))).toBe(false)
  })

  it("reads records only through a granted container and connection", () => {
    ok(Grants.canRead(builder, record(), connections))
    ok(Grants.canRead(builder, record({ access: { containerId: null } }), connections))
    expect(reason(Grants.canRead({ ...builder, status: "retired" }, record(), connections))).toBe("inactive")
    expect(reason(Grants.canRead(builder, record({ deleted: true }), connections))).toBe("tombstone")
    expect(reason(Grants.canRead(builder, record({ connectionId: "nope" }), connections))).toBe("unknown-connection")
    expect(reason(Grants.canRead(builder, record({ connectionId: "personal-mail" }), connections))).toBe(
      "personal-connection"
    )
    expect(reason(Grants.canRead(builder, record({ connectionId: "slack-assistant" }), connections))).toBe(
      "connection-not-granted"
    )
    expect(reason(Grants.canRead(builder, record({ access: { containerId: "C0OTHER" } }), connections))).toBe(
      "container-not-granted"
    )
    expect(
      reason(
        Grants.canRead(builder, record({ access: { containerId: null }, thread: { containerId: null } }), connections)
      )
    ).toBe("container-not-granted")
    const writeOnly = withGrants(builder, {
      connections: [{ connection: "slack-builder", containers: ["C0TEAM"], access: "write" }]
    })
    expect(reason(Grants.canRead(writeOnly, record(), connections))).toBe("access-not-granted")
  })

  it("lets only the assistant read personal records, including ones naming no container", () => {
    const personal = record({
      connectionId: "personal-calendar",
      access: { containerId: null },
      thread: { containerId: null }
    })
    ok(Grants.canRead(assistant, personal, connections))
    const child = { ...assistant, id: "assistant.helper", kind: "helper" as const, hiredBy: "assistant" }
    expect(reason(Grants.canRead(child, personal, connections))).toBe("personal-connection")
  })

  it("writes only with write access to the named container", () => {
    ok(Grants.canWrite(builder, "slack-builder", "C0TEAM", connections))
    expect(reason(Grants.canWrite(builder, "github-product", "example/product", connections))).toBe(
      "access-not-granted"
    )
    expect(reason(Grants.canWrite(builder, "slack-builder", "*", connections))).toBe("container-not-granted")
    expect(reason(Grants.canWrite(builder, "personal-calendar", "primary", connections))).toBe("personal-connection")
    expect(reason(Grants.canWrite({ ...builder, status: "paused" }, "slack-builder", "C0TEAM", connections))).toBe(
      "inactive"
    )
    ok(Grants.canWrite(assistant, "personal-calendar", "primary", connections))
  })

  it("resolves credentials only for granted connections, personal ones only for the assistant", () => {
    ok(Grants.canResolveCredential(builder, "slack-builder", connections))
    ok(Grants.canResolveCredential(assistant, "personal-mail", connections))
    expect(reason(Grants.canResolveCredential(builder, "slack-assistant", connections))).toBe("connection-not-granted")
    expect(reason(Grants.canResolveCredential(builder, "personal-mail", connections))).toBe("personal-connection")
    expect(reason(Grants.canResolveCredential(builder, "missing", connections))).toBe("unknown-connection")
    expect(reason(Grants.canResolveCredential({ ...assistant, status: "retired" }, "personal-mail", connections))).toBe(
      "inactive"
    )
  })

  it("reads wiki files only inside knowledge grants", () => {
    ok(Grants.canReadKnowledge(builder, "Org/Roles/builder.md"))
    ok(Grants.canReadKnowledge(builder, "Org/Playbooks/deploy/checklist.md"))
    expect(reason(Grants.canReadKnowledge(builder, "Org/Roles/lead.md"))).toBe("knowledge-not-granted")
    expect(reason(Grants.canReadKnowledge(builder, "Org/Playbooks/../Roles/lead.md"))).toBe("invalid-path")
    expect(reason(Grants.canReadKnowledge(builder, "Org/Playbooks/"))).toBe("invalid-path")
    expect(reason(Grants.canReadKnowledge({ ...builder, status: "paused" }, "Org/Roles/builder.md"))).toBe("inactive")
    // A grant outside the grammar (never decodable) grants nothing.
    expect(reason(Grants.canReadKnowledge(withGrants(builder, { knowledge: ["Org/*"] }), "Org/x.md"))).toBe(
      "knowledge-not-granted"
    )
  })
})

describe("Grants.canContactOwner", () => {
  let assistant: Profile.Profile
  let builder: Profile.Profile
  const issuer = Grants.makeReceiptIssuer("host/meetings")
  const context = { destination: "slack:D0OWNER", nowMs: 1_000_000 }
  const window = { windowStartMs: 900_000, windowEndMs: 2_700_000 }

  beforeAll(async () => {
    const roster = await loadExample()
    assistant = profileOf(roster, "assistant")
    builder = profileOf(roster, "builder")
  })

  const reason = (result: Result.Result<void, Grants.Denied>) => err(result).reason

  it("always lets the assistant contact the owner", () => {
    ok(Grants.canContactOwner(assistant, undefined, context))
    expect(reason(Grants.canContactOwner({ ...assistant, status: "paused" }, undefined, context))).toBe("inactive")
  })

  it("refuses owner-direct on anyone but the assistant", () => {
    const impostor = withGrants(builder, { contact: "owner-direct" })
    expect(reason(Grants.canContactOwner(impostor, undefined, context))).toBe("not-assistant")
  })

  it("refuses via-parent principals even with a receipt", () => {
    const helper = withGrants(builder, { contact: "via-parent" })
    const receipt = ok(
      issuer.issue({ kind: "one-on-one", principal: helper.id, destination: context.destination, ...window })
    )
    expect(reason(Grants.canContactOwner(helper, receipt, context))).toBe("via-parent")
  })

  it("allows via-assistant contact only under a matching trusted receipt", () => {
    const receipt = ok(
      issuer.issue({ kind: "one-on-one", principal: "builder", destination: context.destination, ...window })
    )
    expect(receipt.issuedBy).toBe("host/meetings")
    expect(Object.isFrozen(receipt)).toBe(true)
    ok(Grants.canContactOwner(builder, receipt, context))
    expect(reason(Grants.canContactOwner(builder, undefined, context))).toBe("no-receipt")
    expect(reason(Grants.canContactOwner(builder, receipt, { ...context, destination: "slack:C0TEAM" }))).toBe(
      "receipt-destination"
    )
    expect(reason(Grants.canContactOwner(builder, receipt, { ...context, nowMs: window.windowEndMs }))).toBe(
      "receipt-window"
    )
    expect(reason(Grants.canContactOwner(builder, receipt, { ...context, nowMs: window.windowStartMs - 1 }))).toBe(
      "receipt-window"
    )
    const other = ok(
      issuer.issue({ kind: "owner-thread", principal: "checker", destination: context.destination, ...window })
    )
    expect(reason(Grants.canContactOwner(builder, other, context))).toBe("receipt-principal")
  })

  it("never trusts a receipt that was not minted by an issuer", () => {
    const receipt = ok(
      issuer.issue({ kind: "owner-thread", principal: "builder", destination: context.destination, ...window })
    )
    const forged: Grants.ContactReceipt = JSON.parse(JSON.stringify(receipt))
    expect(forged).toEqual(receipt)
    expect(reason(Grants.canContactOwner(builder, forged, context))).toBe("untrusted-receipt")
    expect(reason(Grants.canContactOwner(builder, { ...receipt }, context))).toBe("untrusted-receipt")
    expect(() => {
      ;(receipt as { destination: string }).destination = "slack:C0TEAM"
    }).toThrow(TypeError)
  })

  it("refuses receipts without a bounded window or destination", () => {
    const base = { kind: "one-on-one" as const, principal: "builder", destination: context.destination }
    for (
      const bad of [
        { windowStartMs: 10, windowEndMs: 10 },
        { windowStartMs: 10, windowEndMs: 5 },
        { windowStartMs: 0, windowEndMs: Grants.maxReceiptWindowMs + 1 },
        { windowStartMs: 0, windowEndMs: Number.POSITIVE_INFINITY }
      ]
    ) {
      expect(err(issuer.issue({ ...base, ...bad })).reason).toBe("invalid-receipt")
    }
    expect(err(issuer.issue({ ...base, destination: "", ...window })).reason).toBe("invalid-receipt")
  })
})
