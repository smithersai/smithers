import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import * as Hiring from "../src/Hiring.ts"
import type * as Profile from "../src/Profile.ts"
import * as Roster from "../src/Roster.ts"
import {
  copyExample,
  err,
  examplePolicy,
  type Fault,
  faultyLayer,
  loadExample,
  nodeLayer,
  ok,
  profileOf,
  tempDir,
  withGrants
} from "./support.ts"

const at = "2026-09-25T17:00:00Z"
const later = "2026-09-26T17:00:00Z"

const codes = (violations: ReadonlyArray<Roster.Violation>) =>
  violations.map((violation) => `${violation.code}:${violation.principal}`)

const rosterOf = (...profiles: ReadonlyArray<Profile.Profile>) => ({
  profiles: new Map(profiles.map((profile) => [profile.id, profile] as const))
})

describe("Hiring.specialistId", () => {
  it("prefixes the parent and refuses bad slugs or ids past the grammar", () => {
    expect(ok(Hiring.specialistId("lead", "research"))).toBe("lead.research")
    expect(ok(Hiring.specialistId("lead.a.b", "c"))).toBe("lead.a.b.c")
    expect(err(Hiring.specialistId("lead", "Bad"))).toBe("a hire slug is one lowercase id segment")
    expect(err(Hiring.specialistId("lead", "a.b"))).toBe("a hire slug is one lowercase id segment")
    expect(err(Hiring.specialistId("lead.a.b.c", "d"))).toBe("the hire would exceed the principal id grammar or depth")
  })
})

describe("Hiring.propose", () => {
  let roster: Roster.Roster
  let lead: Profile.Profile
  let research: Profile.Profile

  beforeAll(async () => {
    roster = await loadExample()
    lead = profileOf(roster, "lead")
    research = profileOf(roster, "lead.research")
  })

  const request = (patch: Partial<Hiring.HireRequest> = {}): Hiring.HireRequest => ({
    parent: "lead",
    slug: "docs",
    name: "Docs writer",
    kind: "specialist",
    charter: research.charter,
    grants: research.grants,
    budget: { tokensPerTask: 10_000, tasksPerDay: 2, concurrency: 1 },
    skills: ["research"],
    at,
    ...patch
  })

  const refusal = (patch: Partial<Hiring.HireRequest>, over: Pick<Roster.Roster, "profiles"> = roster) =>
    codes(err(Hiring.propose(request(patch), over, examplePolicy)))

  it("builds a proposed profile that passes the roster invariants", () => {
    const hired = ok(Hiring.propose(request(), roster, examplePolicy))
    expect(hired).toMatchObject({
      id: "lead.docs",
      kind: "specialist",
      status: "proposed",
      version: "1.0.0",
      reportsTo: "lead",
      seat: lead.seat,
      memory: { namespace: "agent-lead.docs" },
      cases: [],
      identities: {},
      hiredBy: "lead",
      hiredAt: at
    })
    expect("effort" in hired).toBe(false)
    expect("taskScope" in hired).toBe(false)
    expect(Roster.validate([...roster.profiles.values(), hired], examplePolicy)).toEqual([])
    const helper = ok(Hiring.propose(
      request({ kind: "helper", taskScope: "task-7", seat: "openai:gpt-6-luna", effort: "low" }),
      roster,
      examplePolicy
    ))
    expect(helper).toMatchObject({ kind: "helper", taskScope: "task-7", seat: "openai:gpt-6-luna", effort: "low" })
  })

  it("refuses a malformed id, an unknown hirer, and an inactive hiring chain", () => {
    expect(refusal({ slug: "Bad" })).toEqual(["specialist-prefix:lead"])
    expect(refusal({ parent: "ghost" })).toEqual(["unknown-hirer:ghost.docs"])
    expect(refusal({}, rosterOf(...roster.profiles.values(), { ...lead, status: "paused" }))).toEqual([
      "parent-inactive:lead.docs"
    ])
    const deeper = withGrants(research, { hiring: { maxDepth: 1, maxChildren: 1, maxPersistent: 1 } })
    const pausedChain = rosterOf(...roster.profiles.values(), deeper, { ...lead, status: "paused" })
    expect(refusal({ parent: "lead.research" }, pausedChain)).toEqual(["parent-inactive:lead.research.docs"])
  })

  it("refuses a profile the schema rejects, naming fields without values", () => {
    const refused = err(
      Hiring.propose(request({ budget: { tokensPerTask: 0, tasksPerDay: 1, concurrency: 1 } }), roster, examplePolicy)
    )
    expect(refused).toEqual([{
      code: "invalid-profile",
      principal: "lead.docs",
      message: "budget.tokensPerTask expected a value greater than 0"
    }])
    expect(refusal({ skills: ["Not A Skill"] })).toEqual(["invalid-profile:lead.docs"])
  })

  it("refuses grants beyond the parent's, personal accounts, and owner contact", () => {
    expect(refusal({ grants: { ...research.grants, tools: ["workspace"] } })).toEqual(["grants-widen:lead.docs"])
    expect(refusal({ grants: { ...research.grants, repositories: ["other/repo"] } })).toEqual([
      "grants-widen:lead.docs"
    ])
    expect(refusal({ grants: { ...research.grants, personalAccounts: true } })).toEqual(
      expect.arrayContaining(["hired-personal:lead.docs", "grants-widen:lead.docs", "assistant-multiple:lead.docs"])
    )
    expect(refusal({ grants: { ...research.grants, contact: "owner-direct" } })).toEqual(
      expect.arrayContaining(["hired-personal:lead.docs", "owner-direct-not-assistant:lead.docs"])
    )
  })

  it("refuses hiring beyond depth, children, persistent, and budget limits", () => {
    // lead.research holds no hiring grant.
    expect(refusal({ parent: "lead.research" })).toEqual([
      "children-exceeded:lead.research",
      "persistent-exceeded:lead.research",
      "hiring-not-granted:lead.research.docs"
    ])
    const deepHiring = { ...research.grants, hiring: { maxDepth: 2, maxChildren: 1, maxPersistent: 1 } }
    expect(refusal({ grants: deepHiring })).toEqual(["grants-widen:lead.docs"])
    const zeroDepth = withGrants(research, { hiring: { maxDepth: 0, maxChildren: 1, maxPersistent: 1 } })
    expect(refusal({ parent: "lead.research" }, rosterOf(...roster.profiles.values(), zeroDepth))).toEqual([
      "depth-exceeded:lead.research.docs"
    ])
    // lead: maxChildren 3, maxPersistent 2, and lead.research is one specialist already.
    const second = ok(Hiring.propose(request(), roster, examplePolicy))
    const withSecond = rosterOf(...roster.profiles.values(), second)
    expect(refusal({ slug: "third" }, withSecond)).toEqual(["persistent-exceeded:lead"])
    const helper = ok(
      Hiring.propose(request({ slug: "third", kind: "helper", taskScope: "t" }), withSecond, examplePolicy)
    )
    expect(
      refusal({ slug: "fourth", kind: "helper", taskScope: "t" }, rosterOf(...withSecond.profiles.values(), helper))
    )
      .toEqual(["children-exceeded:lead"])
    expect(refusal({ budget: { tokensPerTask: 300_000, tasksPerDay: 30, concurrency: 1 } })).toEqual([
      "budget-exceeded:lead"
    ])
  })

  it("refuses a reused id, even a retired one, and ignores unrelated existing problems", () => {
    expect(refusal({ slug: "research" })).toEqual(expect.arrayContaining(["duplicate-id:lead.research"]))
    const retired = ok(Hiring.transition(research, "retire", at))
    expect(refusal({ slug: "research" }, rosterOf(...roster.profiles.values(), retired))).toEqual(
      expect.arrayContaining(["duplicate-id:lead.research"])
    )
    const { meeting: _meeting, ...checker } = profileOf(roster, "checker")
    const broken = rosterOf(...roster.profiles.values(), checker)
    expect(codes(Roster.validate([...broken.profiles.values()], examplePolicy))).toEqual(["weekly-meeting:checker"])
    expect(Result.isSuccess(Hiring.propose(request(), broken, examplePolicy))).toBe(true)
  })
})

describe("Hiring.fromSpec", () => {
  let roster: Roster.Roster
  let lead: Profile.Profile

  beforeAll(async () => {
    roster = await loadExample()
    lead = profileOf(roster, "lead")
  })

  const minimal = {
    slug: "pricing",
    name: "Pricing Researcher",
    objective: "Compare competitor pricing.",
    responsibilities: ["Collect prices with sources"]
  }

  it("fills narrow defaults: a persistent specialist with no grants and a budget below its parent's", () => {
    const request = ok(Hiring.fromSpec(lead, minimal, at, "task-1"))
    expect(request).toEqual({
      parent: "lead",
      slug: "pricing",
      name: "Pricing Researcher",
      kind: "specialist",
      charter: {
        objective: "Compare competitor pricing.",
        responsibilities: ["Collect prices with sources"],
        inputs: ["Tasks from lead."],
        allowedActions: ["Answer tasks from lead within the granted knowledge and tools."],
        output: {
          fields: [{ name: "report", description: "The findings, each with its source and date" }],
          evidence: ["The source and date of every claim; unverified claims labeled."]
        },
        escalation: ["Anything outside this charter: return blocked to lead."],
        successCriteria: ["lead accepts the output after review."],
        boundaries: ["Reports only to lead; never contacts the owner."]
      },
      grants: {
        tools: [],
        connections: [],
        knowledge: [],
        repositories: [],
        personalAccounts: false,
        contact: "via-parent"
      },
      budget: {
        tokensPerTask: Math.min(Hiring.defaultHireBudget.tokensPerTask, lead.budget.tokensPerTask),
        tasksPerDay: Math.min(Hiring.defaultHireBudget.tasksPerDay, lead.budget.tasksPerDay),
        concurrency: Math.min(Hiring.defaultHireBudget.concurrency, lead.budget.concurrency)
      },
      skills: [],
      at
    })
    const proposed = ok(Hiring.propose(request, roster, examplePolicy))
    expect(proposed.memory.namespace).toBe("agent-lead.pricing")
  })

  it("keeps what the role asked for, and scopes a helper to the task", () => {
    const request = ok(Hiring.fromSpec(
      lead,
      {
        ...minimal,
        kind: "helper",
        outputs: [{ name: "brief", description: "The brief" }],
        tools: ["wiki-read"],
        connections: [],
        knowledge: ["Org/Roles/"],
        repositories: ["example/demo"],
        skills: ["research"],
        personalAccounts: false,
        contact: "via-parent",
        hiring: { maxDepth: 0, maxChildren: 0, maxPersistent: 0 },
        budget: { tokensPerTask: 5_000, tasksPerDay: 1, concurrency: 1 },
        boundaries: ["Only public sources."]
      },
      at,
      "task-1"
    ))
    expect(request).toMatchObject({
      kind: "helper",
      taskScope: "task-1",
      skills: ["research"],
      budget: { tokensPerTask: 5_000, tasksPerDay: 1, concurrency: 1 },
      grants: {
        tools: ["wiki-read"],
        knowledge: ["Org/Roles/"],
        repositories: ["example/demo"],
        hiring: { maxDepth: 0, maxChildren: 0, maxPersistent: 0 }
      }
    })
    expect(request.charter.output.fields).toEqual([{ name: "brief", description: "The brief" }])
    expect(request.charter.boundaries).toEqual(["Only public sources."])
    expect(ok(Hiring.fromSpec(lead, { ...minimal, kind: "helper" }, at)).taskScope).toBeUndefined()
  })

  describe("web retrieval scope", () => {
    const scoped = (retrieval?: Profile.RetrievalScope): Profile.Profile => ({
      ...lead,
      grants: {
        ...lead.grants,
        tools: [...new Set([...lead.grants.tools, "retrieval" as const])],
        ...(retrieval === undefined ? {} : { retrieval })
      }
    })
    const rosterWith = (parent: Profile.Profile) => ({ profiles: new Map([...roster.profiles, [parent.id, parent]]) })
    const hire = (parent: Profile.Profile, spec: Record<string, unknown>) =>
      Hiring.propose(
        ok(Hiring.fromSpec(parent, { ...minimal, tools: ["retrieval"], ...spec }, at)),
        rosterWith(parent),
        examplePolicy
      )

    it("accepts a narrower scope inside a restricted parent's, keeping the parent's denials", () => {
      const parent = scoped({ allow: ["cursor.com", "devin.ai"], deny: ["forum.cursor.com"] })
      const hired = ok(hire(parent, { retrieval: { allow: ["cursor.com"] } }))
      expect(hired.grants.retrieval).toEqual({ allow: ["cursor.com"], deny: ["forum.cursor.com"] })
      const sub = ok(hire(parent, { retrieval: { allow: ["docs.cursor.com"], deny: ["x.cursor.com"] } }))
      expect(sub.grants.retrieval).toEqual({ allow: ["docs.cursor.com"], deny: ["x.cursor.com", "forum.cursor.com"] })
    })

    it("takes a restricted parent's scope when the hire names none", () => {
      const parent = scoped({ allow: ["cursor.com"] })
      expect(ok(hire(parent, {})).grants.retrieval).toEqual({ allow: ["cursor.com"] })
      const denyOnly = scoped({ deny: ["example.com"] })
      expect(ok(hire(denyOnly, {})).grants.retrieval).toEqual({ deny: ["example.com"] })
      expect(ok(hire(denyOnly, { retrieval: { allow: ["ona.com"] } })).grants.retrieval).toEqual({
        allow: ["ona.com"],
        deny: ["example.com"]
      })
    })

    it("refuses a scope wider than the parent's", () => {
      const parent = scoped({ allow: ["cursor.com"] })
      const refused = err(hire(parent, { retrieval: { allow: ["cursor.com", "devin.ai"] } }))
      expect(codes(refused)).toContain("grants-widen:lead.pricing")
      expect(refused.map((violation) => violation.message).join("; ")).toContain(
        "domain devin.ai is outside the parent's"
      )
    })

    it("adds no scope for an unrestricted parent, and passes a scope without the tool through unchanged", () => {
      expect(ok(hire(scoped(), {})).grants.retrieval).toBeUndefined()
      const request = ok(
        Hiring.fromSpec(scoped({ allow: ["cursor.com"] }), { ...minimal, retrieval: { allow: ["a.com"] } }, at)
      )
      expect(request.grants.retrieval).toEqual({ allow: ["a.com"] })
      expect(ok(Hiring.fromSpec(lead, minimal, at)).grants.retrieval).toBeUndefined()
    })
  })

  it("refuses a field that does not decode, naming the problem", () => {
    const [violation] = err(Hiring.fromSpec(lead, { ...minimal, slug: "Bad Slug", smuggled: true }, at))
    expect(violation).toMatchObject({ code: "invalid-profile", principal: "lead" })
    expect(violation!.message).toContain("the hire request does not decode")
    expect(err(Hiring.fromSpec(lead, null, at))[0]!.code).toBe("invalid-profile")
  })

  it("leaves refusing personal accounts and wider grants to propose", () => {
    const personal = ok(Hiring.fromSpec(lead, { ...minimal, personalAccounts: true, contact: "owner-direct" }, at))
    expect(codes(err(Hiring.propose(personal, roster, examplePolicy)))).toContain("hired-personal:lead.pricing")
    const wide = ok(Hiring.fromSpec(lead, { ...minimal, knowledge: ["Secret/"] }, at))
    expect(codes(err(Hiring.propose(wide, roster, examplePolicy)))).toContain("grants-widen:lead.pricing")
  })
})

describe("Hiring.transition", () => {
  let research: Profile.Profile

  beforeAll(async () => {
    research = profileOf(await loadExample(), "lead.research")
  })

  it("follows the lifecycle state machine", () => {
    const proposed = { ...research, status: "proposed" as const }
    const statuses: ReadonlyArray<Profile.Status> = ["proposed", "active", "paused", "retired"]
    const actions: ReadonlyArray<Hiring.Action> = ["activate", "pause", "resume", "retire"]
    const table: Record<string, Profile.Status | "refused"> = {}
    for (const status of statuses) {
      for (const action of actions) {
        const result = Hiring.transition({ ...proposed, status }, action, at)
        table[`${status}:${action}`] = Result.isSuccess(result) ? result.success.status : "refused"
      }
    }
    expect(table).toEqual({
      "proposed:activate": "active",
      "proposed:pause": "refused",
      "proposed:resume": "refused",
      "proposed:retire": "retired",
      "active:activate": "refused",
      "active:pause": "paused",
      "active:resume": "refused",
      "active:retire": "retired",
      "paused:activate": "refused",
      "paused:pause": "refused",
      "paused:resume": "active",
      "paused:retire": "retired",
      "retired:activate": "refused",
      "retired:pause": "refused",
      "retired:resume": "refused",
      "retired:retire": "refused"
    })
    const refused = err(Hiring.transition(proposed, "pause", at))
    expect(refused).toBeInstanceOf(Hiring.TransitionRefused)
    expect(refused).toMatchObject({ principal: "lead.research", from: "proposed", action: "pause" })
  })

  it("revokes every grant and records the time on retirement, keeping memory", () => {
    const retired = ok(Hiring.transition(research, "retire", at))
    expect(retired).toMatchObject({ status: "retired", grants: Hiring.revokedGrants, retiredAt: at })
    expect(retired.memory).toEqual(research.memory)
    expect(err(Hiring.transition(research, "retire", "yesterday")).message).toBe("retirement needs a UTC instant")
    expect(ok(Hiring.transition(research, "pause", "not used")).status).toBe("paused")
  })
})

describe("Hiring.retireWithHires and settleTask", () => {
  let roster: Roster.Roster
  let research: Profile.Profile

  beforeAll(async () => {
    roster = await loadExample()
    research = profileOf(roster, "lead.research")
  })

  const hire = (id: string, parent: string, patch: Partial<Profile.Profile> = {}): Profile.Profile => ({
    ...research,
    id,
    reportsTo: parent,
    hiredBy: parent,
    memory: { namespace: `agent-${id}` },
    ...patch
  })

  it("retires a principal and everything it hired, root first", () => {
    const child = hire("lead.research.a", "lead.research")
    const grandchild = hire("lead.research.a.b", "lead.research.a")
    const retiredChild = { ...hire("lead.research.c", "lead.research"), status: "retired" as const }
    const org = rosterOf(...roster.profiles.values(), child, grandchild, retiredChild)
    const retired = ok(Hiring.retireWithHires(org, "lead.research", later))
    expect(retired.map((profile) => profile.id)).toEqual(["lead.research", "lead.research.a", "lead.research.a.b"])
    expect(retired.every((profile) => profile.status === "retired" && profile.retiredAt === later)).toBe(true)
    // An already retired root is not retired again, but its live hires are.
    const again = ok(Hiring.retireWithHires(
      rosterOf(...org.profiles.values(), { ...research, status: "retired" }),
      "lead.research",
      later
    ))
    expect(again.map((profile) => profile.id)).toEqual(["lead.research.a", "lead.research.a.b"])
    expect(err(Hiring.retireWithHires(org, "ghost", later))).toMatchObject({ principal: "ghost", action: "retire" })
    expect(err(Hiring.retireWithHires(org, "lead.research", "later")).message).toBe("retirement needs a UTC instant")
  })

  it("retires the helpers scoped to a settled task and their hires only", () => {
    const helper = hire("lead.h1", "lead", { kind: "helper", taskScope: "task-1" })
    const helperHire = hire("lead.h1.x", "lead.h1", { kind: "helper", taskScope: "task-1-sub" })
    const otherTask = hire("lead.h2", "lead", { kind: "helper", taskScope: "task-2" })
    const done = hire("lead.h3", "lead", { kind: "helper", taskScope: "task-1", status: "retired" })
    const specialist = hire("lead.s", "lead", { taskScope: "task-1" })
    const org = rosterOf(...roster.profiles.values(), helper, helperHire, otherTask, done, specialist)
    expect(ok(Hiring.settleTask(org, "task-1", later)).map((profile) => profile.id)).toEqual(["lead.h1", "lead.h1.x"])
    expect(ok(Hiring.settleTask(org, "task-none", later))).toEqual([])
    expect(Result.isFailure(Hiring.settleTask(org, "task-1", "bad"))).toBe(true)
  })
})

describe("Hiring.RosterStore", () => {
  let research: Profile.Profile

  beforeAll(async () => {
    research = profileOf(await loadExample(), "lead.research")
  })

  const withStore = <A, E>(
    dir: string,
    body: (store: Hiring.Service) => Effect.Effect<A, E>,
    fault?: Fault
  ): Promise<A> =>
    Effect.runPromise(
      Effect.gen(function*() {
        return yield* body(yield* Hiring.RosterStore)
      }).pipe(
        Effect.provide(Hiring.layerFileSystem({ dir })),
        Effect.provide(fault === undefined ? nodeLayer : faultyLayer(fault))
      )
    )

  const failure = <A, E>(dir: string, body: (store: Hiring.Service) => Effect.Effect<A, E>, fault?: Fault) =>
    withStore(dir, (store) => Effect.flip(body(store)), fault)

  const sha = (text: string) => createHash("sha256").update(text).digest("hex")

  it("creates, reads, and compare-and-sets hired profiles", async () => {
    const dir = tempDir()
    expect(Option.isNone(await withStore(dir, (store) => store.read("lead.research")))).toBe(true)
    const created = await withStore(dir, (store) => store.write(research))
    const file = join(dir, "Specialists", "lead.research.md")
    const text = readFileSync(file, "utf8")
    expect(text).toBe(Roster.renderProfile(research))
    expect(created).toEqual({ profile: research, digest: sha(text) })
    expect(Option.getOrThrow(await withStore(dir, (store) => store.read("lead.research")))).toEqual(created)
    expect(Option.isNone(await withStore(dir, (store) => store.read("lead.other")))).toBe(true)

    expect(await failure(dir, (store) => store.write(research))).toMatchObject({
      code: "conflict",
      message: "the profile already exists"
    })
    expect(await failure(dir, (store) => store.write(research, sha("stale")))).toMatchObject({
      code: "conflict",
      message: "the stored profile changed"
    })
    expect(await failure(dir, (store) => store.write({ ...research, id: "lead.fresh" }, created.digest))).toMatchObject(
      { code: "conflict", principal: "lead.fresh" }
    )
    const paused = { ...research, status: "paused" as const }
    const updated = await withStore(dir, (store) => store.write(paused, created.digest))
    expect(updated.digest).not.toBe(created.digest)
    expect(Option.getOrThrow(await withStore(dir, (store) => store.read("lead.research"))).profile.status).toBe(
      "paused"
    )
    // No temporary file is left behind.
    expect(readdirSync(join(dir, "Specialists"))).toEqual(["lead.research.md"])
    // The stored file loads back as part of the roster.
    const org = copyExample()
    writeFileSync(join(org, "Specialists", "lead.research.md"), readFileSync(file))
    expect((await Effect.runPromise(Roster.load(org).pipe(Effect.provide(nodeLayer)))).profiles.get("lead.research"))
      .toEqual(paused)
  })

  it("lets exactly one of two concurrent writers win", async () => {
    const dir = tempDir()
    const created = await withStore(dir, (store) => store.write(research))
    const outcomes = await withStore(dir, (store) =>
      Effect.all(
        [
          Effect.result(store.write({ ...research, status: "paused" }, created.digest)),
          Effect.result(store.write({ ...research, name: "Renamed" }, created.digest))
        ],
        { concurrency: "unbounded" }
      ))
    expect(outcomes.filter(Result.isSuccess)).toHaveLength(1)
    expect(outcomes.filter(Result.isFailure).map((outcome) => outcome.failure.code)).toEqual(["conflict"])
  })

  it("refuses core profiles and unparsable stored files", async () => {
    const dir = tempDir()
    expect(await failure(dir, (store) => store.write({ ...research, kind: "core" }))).toMatchObject({
      code: "placement"
    })
    mkdirSync(join(dir, "Specialists"))
    writeFileSync(join(dir, "Specialists", "lead.broken.md"), "no frontmatter")
    expect(await failure(dir, (store) => store.read("lead.broken"))).toMatchObject({
      code: "parse",
      principal: "lead.broken"
    })
  })

  it("refuses paths that resolve outside the roster directory", async () => {
    const outside = tempDir()
    writeFileSync(join(outside, "lead.research.md"), Roster.renderProfile(research))
    const linkedDirectory = tempDir()
    symlinkSync(outside, join(linkedDirectory, "Specialists"))
    expect(await failure(linkedDirectory, (store) => store.read("lead.research"))).toMatchObject({
      code: "confinement"
    })
    const linkedFile = tempDir()
    mkdirSync(join(linkedFile, "Specialists"))
    symlinkSync(join(outside, "lead.research.md"), join(linkedFile, "Specialists", "lead.research.md"))
    expect(await failure(linkedFile, (store) => store.read("lead.research"))).toMatchObject({ code: "confinement" })
    expect(await failure(linkedFile, (store) => store.write(research, sha(Roster.renderProfile(research)))))
      .toMatchObject({ code: "confinement" })
    // The outside file is untouched.
    expect(readFileSync(join(outside, "lead.research.md"), "utf8")).toBe(Roster.renderProfile(research))
  })

  it("maps filesystem failures to io errors and removes a failed temporary file", async () => {
    const dir = tempDir()
    await withStore(dir, (store) => store.write(research))
    const cases: ReadonlyArray<
      readonly [string, Fault, (store: Hiring.Service) => Effect.Effect<unknown, Hiring.RosterStoreError>]
    > = [
      [
        "store check",
        (method, path) => method === "exists" && path.endsWith("Specialists"),
        (store) => store.read("lead.research")
      ],
      [
        "file check",
        (method, path) => method === "exists" && path.endsWith(".md"),
        (store) => store.read("lead.research")
      ],
      ["root", (method, path) => method === "realPath" && path === dir, (store) => store.read("lead.research")],
      [
        "resolve",
        (method, path) => method === "realPath" && path.endsWith(".md"),
        (store) => store.read("lead.research")
      ],
      ["read", (method) => method === "readFileString", (store) => store.read("lead.research")],
      ["create", (method) => method === "makeDirectory", (store) => store.write(research)],
      ["write", (method) => method === "writeFileString", (store) => store.write({ ...research, id: "lead.new" })],
      ["rename", (method) => method === "rename", (store) => store.write({ ...research, id: "lead.new" })]
    ]
    for (const [label, fault, body] of cases) {
      expect(await failure(dir, body, fault), label).toMatchObject({ code: "io" })
    }
    expect(readdirSync(join(dir, "Specialists"))).toEqual(["lead.research.md"])
    expect(existsSync(join(dir, "Specialists", "lead.new.md"))).toBe(false)
  })
})
