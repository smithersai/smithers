import { describe, expect, test } from "vitest"
import type { Actor, ActKind } from "../Actor.ts"
import { parseAdminLogins } from "../DeploymentPolicy.vibe"
import {
  type Artifact,
  canonicalRepositoryId,
  canRead as canReadWith,
  defaultVisibility,
  effectiveVisibility,
  FORBIDDEN,
  NOT_FOUND,
  type Policy,
  readArtifact as readArtifactWith,
  type Repository,
  setVisibility as setVisibilityWith,
} from "./ArtifactVisibility.ts"

const policy: Policy = { admins: parseAdminLogins("roninjin10") }

/** The actor's role as if resolved for the artifact's own repository: what a route does before it asks. */
const onOwn = (actor: Actor | undefined, artifact: Artifact | undefined) =>
  actor === undefined || artifact === undefined ? undefined : { repoId: artifact.repository.fullName, role: actor.role }
const canRead = (actor: Actor | undefined, artifact: Artifact, p: Policy) => canReadWith(actor, artifact, p, onOwn(actor, artifact))
const readArtifact = (actor: Actor | undefined, artifact: Artifact | undefined, p: Policy) =>
  readArtifactWith(actor, artifact, p, onOwn(actor, artifact))
const setVisibility = (actor: Actor | undefined, artifact: Artifact | undefined, visibility: string, p: Policy) =>
  setVisibilityWith(actor, artifact, visibility, p, onOwn(actor, artifact))

const ops = { fullName: "smithersai/Smithers-Ops", private: true }
const privateRepo = { fullName: "smithersai/plue", private: true }
const publicRepo = { fullName: "smithersai/smithers", private: false }

const person = (login: string, role: Actor["role"], id = `person-${login}`): Actor => ({ subject: { kind: "person", id }, role, login })
const delegated = (actor: Actor, kind: ActKind): Actor => ({ ...actor, act: { kind, id: `${kind}-run` } })

const will = person("roninjin10", "admin")
const stranger = person("mallory", null)
const member = person("maria", "member")
const maintainer = person("max", "maintainer")
const repoAdmin = person("ada", "admin")

const secretNote: Artifact = {
  repository: ops,
  path: "notes/incident-2026-11-20.md",
  title: "Payroll provider credentials rotation",
  size: 4_096,
  owner: will.subject.id,
}

/** Every caller that is not roninjin10 acting in person. */
const outsiders: ReadonlyArray<readonly [string, Actor | undefined]> = [
  ["anonymous", undefined],
  ["signed-in stranger", stranger],
  ["repository member", member],
  ["repository maintainer", maintainer],
  ["repository admin", repoAdmin],
  ...(["agent", "flow", "app", "sandbox"] as const).map((kind) => [`${kind} acting for roninjin10`, delegated(will, kind)] as const),
  ...(["agent", "flow"] as const).map((kind) => [`${kind} acting for a member`, delegated(member, kind)] as const),
]

/** Everything a response could leak about the artifact. */
const leaks = (response: unknown) => {
  const text = JSON.stringify(response)
  return [secretNote.title, secretNote.path, "incident", "Payroll", String(secretNote.size), "owner_only", will.subject.id]
    .filter((fragment) => text.includes(fragment))
}

describe("a private Smithers-Ops repository", () => {
  test("roninjin10, in person, reads its notes", () => {
    expect(readArtifact(will, secretNote, policy)).toEqual({
      status: 200,
      body: { path: secretNote.path, title: secretNote.title, size: secretNote.size, visibility: "owner_only" },
    })
  })

  test("the policy names nobody when DEPLOYMENT_ADMIN_LOGINS is unset", () => {
    expect(readArtifact(will, secretNote, { admins: parseAdminLogins("") })).toEqual(NOT_FOUND)
  })

  test.each(outsiders)("%s reads 404, identical to a missing artifact, with no metadata", (_, actor) => {
    const hidden = readArtifact(actor, secretNote, policy)
    expect(hidden).toEqual(NOT_FOUND)
    expect(hidden).toEqual(readArtifact(actor, undefined, policy))
    expect(leaks(hidden)).toEqual([])
  })

  test.each(outsiders)("%s cannot flip visibility: 404, identical to a missing artifact", (_, actor) => {
    for (const visibility of ["public", "repo_members", "owner_only", "bogus"]) {
      const refused = setVisibility(actor, secretNote, visibility, policy)
      expect(refused).toEqual(NOT_FOUND)
      expect(refused).toEqual(setVisibility(actor, undefined, visibility, policy))
      expect(leaks(refused)).toEqual([])
    }
  })

  test("a stored public visibility, even with a person's approval, stays owner-only", () => {
    const widened: Artifact = { ...secretNote, visibility: "public", approvedBy: { kind: "person", id: will.subject.id, login: "roninjin10" } }
    expect(effectiveVisibility(widened, policy)).toBe("owner_only")
    for (const [, actor] of outsiders) expect(readArtifact(actor, widened, policy)).toEqual(NOT_FOUND)
  })

  test("roninjin10 cannot widen it either, and the refusal is a fixed 403", () => {
    expect(setVisibility(will, secretNote, "public", policy)).toEqual(FORBIDDEN)
    expect(setVisibility(will, secretNote, "repo_members", policy)).toEqual(FORBIDDEN)
    expect(setVisibility(will, secretNote, "owner_only", policy)).toMatchObject({ status: 200, body: { visibility: "owner_only" } })
  })

  test("the repository match ignores case", () => {
    const shouted = { ...secretNote, repository: { fullName: "SMITHERSAI/SMITHERS-OPS", private: true } }
    expect(readArtifact(member, shouted, policy)).toEqual(NOT_FOUND)
  })
})

describe("defaults fail closed", () => {
  test("ops repositories default owner-only, every other repository members-only", () => {
    expect(defaultVisibility(ops, policy)).toBe("owner_only")
    expect(defaultVisibility(privateRepo, policy)).toBe("repo_members")
    expect(defaultVisibility(publicRepo, policy)).toBe("repo_members")
  })

  test("a missing, unknown, or unapproved public visibility falls back to members-only", () => {
    const base: Artifact = { repository: publicRepo, path: "a.md", title: "A", size: 1, owner: member.subject.id }
    expect(effectiveVisibility(base, policy)).toBe("repo_members")
    expect(effectiveVisibility({ ...base, visibility: "everyone" }, policy)).toBe("repo_members")
    expect(effectiveVisibility({ ...base, visibility: "public" }, policy)).toBe("repo_members")
    const forged = { ...base, visibility: "public", approvedBy: { kind: "agent", id: "agent-run", login: "maria" } } as unknown as Artifact
    expect(effectiveVisibility(forged, policy)).toBe("repo_members")
    expect(readArtifact(undefined, forged, policy)).toEqual(NOT_FOUND)
  })
})

describe("per-artifact visibility on an ordinary repository", () => {
  const draft: Artifact = { repository: privateRepo, path: "plans/q1.md", title: "Q1", size: 10, owner: member.subject.id }

  test("repo_members: members and their runs read, strangers and anonymous get 404", () => {
    expect(canRead(member, draft, policy)).toBe(true)
    expect(canRead(delegated(member, "agent"), draft, policy)).toBe(true)
    expect(readArtifact(stranger, draft, policy)).toEqual(NOT_FOUND)
    expect(readArtifact(undefined, draft, policy)).toEqual(NOT_FOUND)
    expect(readArtifact(person("guest", "guest"), draft, policy)).toEqual(NOT_FOUND)
  })

  test("owner_only: only the owner in person reads, not their agent and not an admin", () => {
    const mine: Artifact = { ...draft, visibility: "owner_only" }
    expect(canRead(member, mine, policy)).toBe(true)
    expect(readArtifact(delegated(member, "agent"), mine, policy)).toEqual(NOT_FOUND)
    expect(readArtifact(repoAdmin, mine, policy)).toEqual(NOT_FOUND)
    expect(readArtifact(will, mine, policy)).toEqual(NOT_FOUND)
  })

  test("public needs a person: an agent gets 403, the owner in person records the approval", () => {
    for (const kind of ["agent", "flow", "app", "sandbox"] as const) {
      expect(setVisibility(delegated(member, kind), draft, "public", policy)).toEqual(FORBIDDEN)
    }
    const published = setVisibility(member, draft, "public", policy)
    expect(published).toEqual({
      status: 200,
      body: { ...draft, visibility: "public", approvedBy: { kind: "person", id: member.subject.id, login: "maria" } },
    })
    if (published.status !== 200) throw new Error("expected 200")
    expect(readArtifact(undefined, published.body, policy)).toMatchObject({ status: 200, body: { visibility: "public" } })
  })

  test("a member who does not own it gets 403, a maintainer may change it", () => {
    const other = person("otto", "member")
    expect(setVisibility(other, draft, "public", policy)).toEqual(FORBIDDEN)
    expect(setVisibility(maintainer, draft, "owner_only", policy)).toMatchObject({ status: 200, body: { visibility: "owner_only" } })
  })

  test("narrowing drops the old approval, and an unknown visibility or missing login is 403", () => {
    const approved: Artifact = { ...draft, visibility: "public", approvedBy: { kind: "person", id: member.subject.id, login: "maria" } }
    const narrowed = setVisibility(member, approved, "repo_members", policy)
    expect(narrowed).toEqual({ status: 200, body: { ...draft, visibility: "repo_members" } })
    expect(setVisibility(member, draft, "world", policy)).toEqual(FORBIDDEN)
    const { login: _login, ...nameless } = member
    expect(setVisibility(nameless, draft, "public", policy)).toEqual(FORBIDDEN)
  })
})

// Regressions for the W2-I review (scratch/w2/astra-review-i.md): one test or more per finding.

const note = (repository: Repository, extra: Partial<Artifact> = {}): Artifact => ({
  repository,
  path: "notes/a.md",
  title: "A",
  size: 1,
  owner: member.subject.id,
  ...extra,
})
const approval = { kind: "person", id: member.subject.id, login: "maria" } as const

describe("High 2: the built-in ops set is additive and every entry is canonical", () => {
  test("a custom ops set adds to smithersai/smithers-ops and never replaces it", () => {
    const custom: Policy = { ...policy, opsRepositories: new Set(["acme/ops"]) }
    const opsNote = note(ops, { visibility: "public", approvedBy: approval })
    expect(readArtifact(member, opsNote, custom)).toEqual(NOT_FOUND)
    expect(readArtifact(undefined, opsNote, custom)).toEqual(NOT_FOUND)
    expect(readArtifact(will, opsNote, custom)).toMatchObject({ status: 200, body: { visibility: "owner_only" } })
    expect(readArtifact(member, note({ fullName: "acme/ops", private: true }), custom)).toEqual(NOT_FOUND)
    expect(readArtifact(member, note({ fullName: "smithersai/Smithers-Ops", private: true }), { ...policy, opsRepositories: [] })).toEqual(NOT_FOUND)
  })

  test("a mixed-case configured entry protects its repository", () => {
    const custom: Policy = { ...policy, opsRepositories: ["Acme/Ops"] }
    for (const fullName of ["acme/ops", "ACME/OPS", "Acme/Ops"]) {
      expect(readArtifact(member, note({ fullName, private: true }), custom)).toEqual(NOT_FOUND)
    }
  })

  test("a malformed configured entry makes every repository ops-only", () => {
    for (const entry of ["acme/ops/", " acme/ops", "acme", "acme//ops", "acme/ops\n"]) {
      const broken: Policy = { ...policy, opsRepositories: [entry] }
      expect(defaultVisibility(privateRepo, broken)).toBe("owner_only")
      expect(readArtifact(member, note(privateRepo), broken)).toEqual(NOT_FOUND)
    }
  })
})

describe("Low 1 (repository IDs): a malformed artifact repository ID is refused before any ACL rule", () => {
  test.each([
    "smithersai/smithers-ops/",
    " smithersai/smithers-ops",
    "smithersai/smithers-ops ",
    "smithersai/smithers-ops\n",
    "smithersai//smithers-ops",
    "smithersai/smithers-ops/extra",
    "smithersai/..",
    "/smithers-ops",
    "",
  ])("%j reads and flips 404 for every caller, even with a stored public approval", (fullName) => {
    expect(canonicalRepositoryId(fullName)).toBeUndefined()
    const odd = note({ fullName, private: true }, { visibility: "public", approvedBy: approval })
    for (const actor of [undefined, member, maintainer, will]) {
      expect(readArtifact(actor, odd, policy)).toEqual(NOT_FOUND)
      expect(setVisibility(actor, odd, "owner_only", policy)).toEqual(NOT_FOUND)
    }
  })

  test("canonical IDs compare lowercase", () => {
    expect(canonicalRepositoryId("SmithersAI/Smithers-Ops")).toBe("smithersai/smithers-ops")
    expect(canonicalRepositoryId("smithersai/smithers.dev")).toBe("smithersai/smithers.dev")
  })
})

describe("Medium 3: a role counts only when resolved for the artifact's own repository", () => {
  const draft = note(privateRepo)
  const elsewhere = (role: Actor["role"]) => ({ repoId: "smithersai/other", role })

  test("a member or maintainer of another repository reads 404 and cannot flip", () => {
    for (const role of ["member", "maintainer", "admin"] as const) {
      const actor = person("eve", role)
      expect(canReadWith(actor, draft, policy, elsewhere(role))).toBe(false)
      expect(readArtifactWith(actor, draft, policy, elsewhere(role))).toEqual(NOT_FOUND)
      expect(setVisibilityWith(actor, draft, "public", policy, elsewhere(role))).toEqual(NOT_FOUND)
    }
  })

  test("the role an Actor carries, with no membership, authorizes nothing", () => {
    expect(readArtifactWith(repoAdmin, draft, policy)).toEqual(NOT_FOUND)
    expect(setVisibilityWith(repoAdmin, draft, "repo_members", policy)).toEqual(NOT_FOUND)
  })

  test("a maintainer of another repository cannot change a public artifact they may read", () => {
    const published = note(privateRepo, { visibility: "public", approvedBy: approval })
    expect(readArtifactWith(maintainer, published, policy, elsewhere("maintainer"))).toMatchObject({ status: 200 })
    expect(setVisibilityWith(maintainer, published, "owner_only", policy, elsewhere("maintainer"))).toEqual(FORBIDDEN)
    expect(setVisibilityWith(maintainer, published, "owner_only", policy, { repoId: "SMITHERSAI/PLUE", role: "maintainer" }))
      .toMatchObject({ status: 200 })
  })

  test("a membership with a malformed repository ID authorizes nothing", () => {
    expect(readArtifactWith(member, draft, policy, { repoId: "smithersai/plue/", role: "member" })).toEqual(NOT_FOUND)
    expect(readArtifactWith(member, draft, policy, { repoId: " smithersai/plue", role: "member" })).toEqual(NOT_FOUND)
  })
})

describe("Low 1 (approvals): a stored public approval needs a person's id and login", () => {
  test.each([
    ["an empty id", { kind: "person", id: "", login: "maria" }],
    ["a blank id", { kind: "person", id: "   ", login: "maria" }],
    ["no id", { kind: "person", login: "maria" }],
    ["an empty login", { kind: "person", id: member.subject.id, login: "" }],
    ["a non-string id", { kind: "person", id: 7, login: "maria" }],
  ])("%s falls back to members-only and reads 404 anonymously", (_, approvedBy) => {
    const imported = note(publicRepo, { visibility: "public", approvedBy: approvedBy as unknown as Artifact["approvedBy"] })
    expect(effectiveVisibility(imported, policy)).toBe("repo_members")
    expect(readArtifact(undefined, imported, policy)).toEqual(NOT_FOUND)
  })

  test("a complete person approval still publishes", () => {
    expect(readArtifact(undefined, note(publicRepo, { visibility: "public", approvedBy: approval }), policy)).toMatchObject({ status: 200 })
  })
})
