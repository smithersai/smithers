import * as Effect from "effect/Effect"
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import type * as Profile from "../src/Profile.ts"
import * as Roster from "../src/Roster.ts"
import {
  copyExample,
  err,
  examplePolicy,
  flip,
  flipWith,
  loadExample,
  ok,
  profileOf,
  readFixture,
  run,
  tempDir,
  withGrants
} from "./support.ts"

const parse = (text: string, path = "Roles/x.md") => Effect.runPromise(Roster.parseProfile(path, text))
const parseError = (text: string, path = "Roles/x.md") =>
  Effect.runPromise(Effect.flip(Roster.parseProfile(path, text)))

const codes = (violations: ReadonlyArray<Roster.Violation>) =>
  violations.map((violation) => `${violation.code}:${violation.principal}`)

const noGrants: Profile.Grants = {
  tools: [],
  connections: [],
  knowledge: [],
  repositories: [],
  personalAccounts: false,
  contact: "via-parent"
}

describe("Roster.parseProfile and renderProfile", () => {
  let roster: Roster.Roster

  beforeAll(async () => {
    roster = await loadExample()
  })

  it("round-trips every fixture profile to the same profile and the same text", async () => {
    for (const profile of roster.profiles.values()) {
      const text = Roster.renderProfile(profile)
      const parsed = await parse(text)
      expect(parsed, profile.id).toEqual(profile)
      expect(Roster.renderProfile(parsed)).toBe(text)
    }
  })

  it("round-trips every optional field and omits empty ones", async () => {
    const lead = profileOf(roster, "lead")
    const full: Profile.Profile = {
      ...lead,
      id: "lead.helper",
      kind: "helper",
      status: "retired",
      reportsTo: "lead",
      effort: "low",
      grants: noGrants,
      budget: { ...lead.budget, usdPerMonth: 12.5 },
      identities: { slack: "slack-a", email: "mail-a", github: "gh-a" },
      meeting: { weekly: false },
      hiredBy: "lead",
      hiredAt: "2026-09-20T16:00:00Z",
      retiredAt: "2026-09-21T16:00:00.500Z",
      taskScope: "task-9",
      charter: { ...lead.charter, boundaries: [] }
    }
    const text = Roster.renderProfile(full)
    expect(text).not.toContain("## Boundaries")
    expect(text).toContain("identities: {slack: slack-a, email: mail-a, github: gh-a}")
    expect(await parse(text)).toEqual(full)
    const { effort: _effort, meeting: _meeting, ...bare } = { ...lead, identities: {} }
    const bareText = Roster.renderProfile(bare)
    expect(bareText).not.toMatch(/effort|meeting|hiredBy|usdPerMonth/)
    expect(await parse(bareText)).toEqual(bare)
  })

  it("parses the documented format example and defaults the memory namespace", async () => {
    const example = await parse(readFixture("../format-example.md"))
    expect(example.id).toBe("builder")
    const text = Roster.renderProfile(profileOf(roster, "checker")).replace("memory: {namespace: agent-checker}\n", "")
    expect((await parse(text)).memory).toEqual({ namespace: "agent-checker" })
    expect(await parse(text.replaceAll("\n", "\r\n"))).toEqual(await parse(text))
  })

  it("joins indented continuation lines and skips blank lines in lists", async () => {
    const text = Roster.renderProfile(profileOf(roster, "checker")).replace(
      "## Inputs\n\n- ",
      "## Inputs\n\n- First part\n  continued here.\n\n- "
    )
    expect((await parse(text)).charter.inputs[0]).toBe("First part continued here.")
  })

  it("refuses malformed files by file and field, never by value", async () => {
    const good = Roster.renderProfile(profileOf(roster, "checker"))
    const secret = "xoxb-111-secret"
    const cases: ReadonlyArray<readonly [string, string, string | undefined]> = [
      ["no frontmatter here", "frontmatter", undefined],
      ["---\nid: [unclosed\n---\n", "frontmatter", undefined],
      [good.replace("id: checker", "id: checker\ncharter: {}"), "schema", "charter"],
      [good.replace("## Objective", "# Objective"), "body", "# Objective"],
      [good.replace("## Objective", "### Objective"), "body", "### Objective"],
      [good.replace("## Evidence", "## Proof"), "body", "## Proof"],
      [good.replace("## Evidence", "## Inputs"), "body", "## Inputs"],
      [good.replace("---\n\n## Objective", "---\n\nPreamble.\n\n## Objective"), "body", "body"],
      [good.replace(/## Escalation\n\n- [^\n]*\n\n/, ""), "body", "## Escalation"],
      [good.replace("## Inputs\n\n- ", "## Inputs\n\n* "), "body", "## Inputs"],
      [good.replace("## Inputs\n\n- ", "## Inputs\n\n  indented\n- "), "body", "## Inputs"],
      [good.replace(" — ", ": "), "body", "## Output"],
      [good.replace("id: checker", "id: Checker"), "schema", "id"],
      [good.replace("slack: ", "x: ").replace("identities: {}", `identities: {slack: ${secret}}`), "schema", undefined]
    ]
    for (const [text, code, field] of cases) {
      const error = await parseError(text)
      expect(error, text.slice(0, 80)).toBeInstanceOf(Roster.RosterError)
      expect(error.code, text.slice(0, 200)).toBe(code)
      if (field !== undefined) expect(error.field, text.slice(0, 200)).toBe(field)
      expect(error.path).toBe("Roles/x.md")
      expect(error.message).not.toContain(secret)
    }
    // A non-string id gets no default namespace; the schema names the id.
    expect((await parseError(good.replace("id: checker", "id: 5").replace(/memory: [^\n]*\n/, ""))).field).toBe("id")
    // Boundaries are optional.
    const without = good.replace(/\n## Boundaries\n\n- [^\n]*\n/, "")
    expect(without).not.toContain("Boundaries")
    expect((await parse(without)).charter.boundaries).toEqual([])
  })
})

describe("Roster.load", () => {
  it("loads Roles and Specialists in name order, ignoring README and non-markdown files", async () => {
    const dir = copyExample()
    writeFileSync(join(dir, "Roles", "notes.txt"), "not a profile")
    const loaded = await run(Roster.load(dir))
    expect([...loaded.profiles.keys()]).toEqual(["assistant", "builder", "checker", "lead", "lead.research"])
    expect(loaded.sources.map((source) => source.path)).toEqual([
      "Roles/assistant.md",
      "Roles/builder.md",
      "Roles/checker.md",
      "Roles/lead.md",
      "Specialists/lead.research.md"
    ])
    expect(loaded.revision).toBe((await loadExample()).revision)
    expect(loaded.revision).toBe(Roster.revisionOf([...loaded.profiles.values()].reverse(), loaded.sources))
    rmSync(join(dir, "Specialists"), { recursive: true })
    expect([...(await run(Roster.load(dir))).profiles.keys()]).not.toContain("lead.research")
  })

  it("pins the revision to the file bytes, not only the parsed profile", async () => {
    const dir = copyExample()
    const file = join(dir, "Roles", "checker.md")
    writeFileSync(file, `${readFileSync(file, "utf8")}\n`)
    const changed = await run(Roster.load(dir))
    const original = await loadExample()
    expect(changed.profiles.get("checker")).toEqual(original.profiles.get("checker"))
    expect(changed.revision).not.toBe(original.revision)
  })

  it("refuses a missing roster or Roles directory", async () => {
    expect(await flip(Roster.load(join(tempDir(), "absent")))).toMatchObject({ code: "read", path: "." })
    const dir = copyExample()
    rmSync(join(dir, "Roles"), { recursive: true })
    expect(await flip(Roster.load(dir))).toMatchObject({ code: "read", path: "Roles" })
  })

  it("refuses symlinks and .. paths that leave the roster directory", async () => {
    const outside = copyExample()
    const linkedDirectory = copyExample()
    rmSync(join(linkedDirectory, "Roles"), { recursive: true })
    symlinkSync(join(outside, "Roles"), join(linkedDirectory, "Roles"))
    expect(await flip(Roster.load(linkedDirectory))).toMatchObject({ code: "confinement", path: "Roles" })

    const linkedFile = copyExample()
    rmSync(join(linkedFile, "Roles", "checker.md"))
    symlinkSync(join(outside, "Roles", "checker.md"), join(linkedFile, "Roles", "checker.md"))
    expect(await flip(Roster.load(linkedFile))).toMatchObject({ code: "confinement", path: "Roles/checker.md" })

    const dotted = copyExample()
    rmSync(join(dotted, "Roles", "checker.md"))
    symlinkSync(`../../${outside.split("/").at(-1)}/Roles/checker.md`, join(dotted, "Roles", "checker.md"))
    expect(await flip(Roster.load(dotted))).toMatchObject({ code: "confinement", path: "Roles/checker.md" })

    const dangling = copyExample()
    symlinkSync(join(outside, "absent.md"), join(dangling, "Roles", "ghost.md"))
    expect(await flip(Roster.load(dangling))).toMatchObject({ code: "read", path: "Roles/ghost.md" })

    // A roster reached through `..` and a link that stays inside are fine.
    const inside = copyExample()
    mkdirSync(join(inside, "Library"))
    rmSync(join(inside, "Roles", "checker.md"))
    writeFileSync(join(inside, "Library", "checker.md"), readFixture("Roles/checker.md"))
    symlinkSync(join(inside, "Library", "checker.md"), join(inside, "Roles", "checker.md"))
    expect((await run(Roster.load(join(inside, "Roles", "..")))).profiles.has("checker")).toBe(true)
  })

  it("accepts a Roles link to the roster directory itself", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "checker.md"), readFixture("Roles/checker.md"))
    symlinkSync(dir, join(dir, "Roles"))
    expect([...(await run(Roster.load(dir))).profiles.keys()]).toEqual(["checker"])
  })

  it("refuses non-files, oversize files, misnamed files, misplaced kinds, and duplicate ids", async () => {
    const directory = copyExample()
    mkdirSync(join(directory, "Roles", "folder.md"))
    expect(await flip(Roster.load(directory))).toMatchObject({ code: "read", path: "Roles/folder.md" })

    const large = copyExample()
    writeFileSync(join(large, "Roles", "big.md"), "x".repeat(Roster.maxProfileBytes + 1))
    expect(await flip(Roster.load(large))).toMatchObject({ code: "too-large", path: "Roles/big.md" })

    const misnamed = copyExample()
    writeFileSync(join(misnamed, "Roles", "other.md"), readFixture("Roles/checker.md"))
    expect(await flip(Roster.load(misnamed))).toMatchObject({ code: "file-name", path: "Roles/other.md" })

    const specialistInRoles = copyExample()
    writeFileSync(join(specialistInRoles, "Roles", "lead.research.md"), readFixture("Specialists/lead.research.md"))
    expect(await flip(Roster.load(specialistInRoles))).toMatchObject({
      code: "placement",
      path: "Roles/lead.research.md"
    })

    const coreInSpecialists = copyExample()
    writeFileSync(
      join(coreInSpecialists, "Specialists", "zed.md"),
      readFixture("Roles/checker.md").replace("id: checker", "id: zed")
    )
    expect(await flip(Roster.load(coreInSpecialists))).toMatchObject({ code: "placement", path: "Specialists/zed.md" })

    const duplicate = copyExample()
    writeFileSync(
      join(duplicate, "Specialists", "lead.md"),
      readFixture("Specialists/lead.research.md").replace("id: lead.research", "id: lead")
    )
    expect(await flip(Roster.load(duplicate))).toMatchObject({ code: "duplicate", path: "Specialists/lead.md" })

    const unparsable = copyExample()
    writeFileSync(join(unparsable, "Roles", "zed.md"), "no frontmatter")
    expect(await flip(Roster.load(unparsable))).toMatchObject({ code: "frontmatter", path: "Roles/zed.md" })
  })

  it("maps every filesystem failure to a read error", async () => {
    const dir = copyExample()
    const cases: ReadonlyArray<readonly [(method: string, path: string) => boolean, string]> = [
      [(method) => method === "exists", "Roles"],
      [(method, path) => method === "realPath" && path.endsWith("/Roles"), "Roles"],
      [(method) => method === "readDirectory", "Roles"],
      [(method, path) => method === "realPath" && path.endsWith("checker.md"), "Roles/checker.md"],
      [(method) => method === "stat", "Roles/assistant.md"],
      [(method) => method === "readFileString", "Roles/assistant.md"]
    ]
    for (const [fault, path] of cases) {
      expect(await flipWith(Roster.load(dir), fault)).toMatchObject({ code: "read", path })
    }
  })
})

describe("Roster.validate", () => {
  let roster: Roster.Roster
  let base: ReadonlyArray<Profile.Profile>
  let lead: Profile.Profile
  let checker: Profile.Profile
  let research: Profile.Profile

  beforeAll(async () => {
    roster = await loadExample()
    base = [...roster.profiles.values()]
    lead = profileOf(roster, "lead")
    checker = profileOf(roster, "checker")
    research = profileOf(roster, "lead.research")
  })

  const replace = (...changed: ReadonlyArray<Profile.Profile>): Array<Profile.Profile> => [
    ...base.map((profile) => changed.find((next) => next.id === profile.id) ?? profile),
    ...changed.filter((next) => !base.some((profile) => profile.id === next.id))
  ]

  const check = (profiles: ReadonlyArray<Profile.Profile>, policy: Roster.Policy = examplePolicy) =>
    codes(Roster.validate(profiles, policy))

  const hire = (id: string, parent: string, patch: Partial<Profile.Profile> = {}): Profile.Profile => ({
    ...research,
    id,
    reportsTo: parent,
    hiredBy: parent,
    memory: { namespace: `agent-${id}` },
    budget: { tokensPerTask: 1000, tasksPerDay: 1, concurrency: 1 },
    ...patch
  })

  it("accepts the fixture roster", () => {
    expect(Roster.validate(base, examplePolicy)).toEqual([])
    expect(Roster.validate(base, { weeklyMeeting: false, skills: examplePolicy.skills })).toEqual([])
  })

  it("reports duplicate ids and memory namespaces", () => {
    expect(check([...base, checker])).toContain("duplicate-id:checker")
    expect(check(replace({ ...checker, memory: { namespace: "agent-lead" } }))).toEqual([
      "duplicate-memory-namespace:lead"
    ])
  })

  it("reports unknown managers and reporting cycles", () => {
    expect(check(replace({ ...checker, reportsTo: "ghost" }))).toEqual(["unknown-manager:checker"])
    expect(check(replace({ ...lead, reportsTo: "builder" }))).toEqual(
      expect.arrayContaining(["reporting-cycle:lead", "reporting-cycle:builder"])
    )
    // A profile that reports into a cycle it is not part of is not itself cyclic.
    const cycle = check(replace({ ...lead, reportsTo: "checker" }, { ...checker, reportsTo: "lead" }))
    expect(cycle).toContain("reporting-cycle:lead")
    expect(cycle).not.toContain("reporting-cycle:builder")
  })

  it("requires exactly one assistant with owner-direct contact", () => {
    const assistant = profileOf(roster, "assistant")
    expect(check(replace(withGrants(assistant, { personalAccounts: false })))).toEqual([
      "assistant-missing:",
      "owner-direct-not-assistant:assistant"
    ])
    expect(check(replace({ ...assistant, status: "paused" }))).toEqual(
      expect.arrayContaining(["assistant-missing:", "assistant-multiple:assistant"])
    )
    expect(check(replace(withGrants(checker, { personalAccounts: true })))).toContain("assistant-multiple:checker")
    expect(check(replace(withGrants(assistant, { contact: "via-assistant" })))).toEqual(
      expect.arrayContaining(["assistant-shape:assistant", "wildcard-container:assistant"])
    )
    expect(check(replace(withGrants(checker, { contact: "owner-direct" })))).toEqual([
      "owner-direct-not-assistant:checker"
    ])
    const hiredAssistant = { ...assistant, hiredBy: "lead", hiredAt: "2026-09-20T16:00:00Z" }
    expect(check(replace(hiredAssistant))).toEqual(
      expect.arrayContaining(["hire-record:assistant", "assistant-shape:assistant"])
    )
  })

  it("keeps hired principals away from personal accounts and owner contact", () => {
    expect(check(replace(withGrants(research, { personalAccounts: true })))).toEqual(
      expect.arrayContaining(["hired-personal:lead.research", "assistant-multiple:lead.research"])
    )
    expect(check(replace(withGrants(research, { contact: "owner-direct" })))).toContain(
      "hired-personal:lead.research"
    )
  })

  it("checks hire records, id prefixes, and task scopes", () => {
    expect(check(replace({ ...checker, taskScope: "t" }))).toEqual(["hire-record:checker"])
    const { hiredAt: _hiredAt, ...unrecorded } = research
    expect(check(replace(unrecorded))).toEqual(["hire-record:lead.research"])
    expect(check(replace({ ...research, reportsTo: "checker" }))).toEqual(["hire-record:lead.research"])
    expect(check(replace({ ...research, taskScope: "task-1" }))).toEqual(["task-scope:lead.research"])
    expect(check([...base, hire("lead.helper", "lead", { kind: "helper" })])).toEqual(["task-scope:lead.helper"])
    expect(check([...base, hire("checker.x", "lead")])).toEqual(["specialist-prefix:checker.x"])
    expect(check([...base, hire("lead.a.b", "lead")])).toEqual(["specialist-prefix:lead.a.b"])
    expect(check([...base, hire("ghost.a", "ghost")])).toEqual(["unknown-manager:ghost.a", "unknown-hirer:ghost.a"])
  })

  it("checks the hirer: active, allowed to hire, and never widened", () => {
    const retiredLead = { ...lead, status: "retired" as const, grants: noGrants, retiredAt: "2026-09-22T00:00:00Z" }
    expect(check(replace(retiredLead))).toEqual(
      expect.arrayContaining(["parent-inactive:lead.research"])
    )
    expect(check(replace(retiredLead))).not.toContain("grants-widen:lead.research")
    const { hiring: _hiring, ...noHiring } = lead.grants
    expect(check(replace({ ...lead, grants: noHiring }))).toEqual(
      expect.arrayContaining(["hiring-not-granted:lead.research"])
    )
    expect(check(replace({ ...lead, grants: noHiring }))).not.toContain("depth-exceeded:lead.research")
    expect(check(replace(withGrants(research, { tools: ["workspace"] })))).toEqual(["grants-widen:lead.research"])
    // A retired hire is no longer checked against its hirer.
    const retiredResearch = {
      ...research,
      status: "retired" as const,
      grants: noGrants,
      retiredAt: "2026-09-22T00:00:00Z"
    }
    expect(
      check(
        replace(retiredResearch, { ...lead, status: "retired", grants: noGrants, retiredAt: "2026-09-22T00:00:00Z" })
      )
    )
      .not.toContain("parent-inactive:lead.research")
  })

  it("enforces every ancestor's depth limit", () => {
    const parent = withGrants(research, { hiring: { maxDepth: 1, maxChildren: 1, maxPersistent: 1 } })
    const deep = hire("lead.research.deep", "lead.research")
    // lead allows maxDepth 2, so two levels are fine.
    expect(check(replace(parent, deep))).toEqual([])
    // A hirer whose own grants were narrowed after it hired still bounds the depth below it.
    const shallowLead = withGrants(lead, { hiring: { maxDepth: 1, maxChildren: 3, maxPersistent: 2 } })
    expect(check(replace(shallowLead, parent, deep))).toEqual([
      "grants-widen:lead.research",
      "depth-exceeded:lead.research.deep"
    ])
    const zeroDepthParent = withGrants(research, { hiring: { maxDepth: 0, maxChildren: 1, maxPersistent: 1 } })
    expect(check(replace(zeroDepthParent, deep))).toEqual(["depth-exceeded:lead.research.deep"])
    // A retired grandparent is not counted; its active hires are still stopped at dispatch.
    const retiredLead = {
      ...shallowLead,
      status: "retired" as const,
      grants: noGrants,
      retiredAt: "2026-09-22T00:00:00Z"
    }
    expect(check(replace(retiredLead, parent, deep))).not.toContain("depth-exceeded:lead.research.deep")
  })

  it("enforces children, persistent, and budget limits on the hirer", () => {
    const helpers = [1, 2, 3].map((n) => hire(`lead.h${n}`, "lead", { kind: "helper", taskScope: `t${n}` }))
    expect(check([...base, ...helpers])).toEqual(["children-exceeded:lead"])
    const specialists = [1, 2].map((n) => hire(`lead.s${n}`, "lead"))
    expect(check([...base, ...specialists])).toEqual(["persistent-exceeded:lead"])
    expect(check([...base, ...specialists, ...helpers])).toEqual(["children-exceeded:lead", "persistent-exceeded:lead"])
    // Retired hires do not count.
    const retired = {
      ...specialists[0]!,
      status: "retired" as const,
      grants: noGrants,
      retiredAt: "2026-09-22T00:00:00Z"
    }
    expect(check([...base, retired])).toEqual([])
    const greedy = hire("lead.big", "lead", { budget: { tokensPerTask: 300_000, tasksPerDay: 30, concurrency: 1 } })
    expect(check([...base, greedy])).toEqual(["budget-exceeded:lead"])
  })

  it("keeps hires inside a USD-capped hirer's monthly budget", () => {
    const assistant = profileOf(roster, "assistant")
    const helper = (usdPerMonth?: number) =>
      hire("assistant.h", "assistant", {
        kind: "helper",
        taskScope: "t1",
        grants: noGrants,
        budget: {
          tokensPerTask: 1000,
          tasksPerDay: 1,
          concurrency: 1,
          ...(usdPerMonth === undefined ? {} : { usdPerMonth })
        }
      })
    expect(check([...base, helper()])).toEqual(["budget-exceeded:assistant"])
    expect(check([...base, helper(201)])).toEqual(["budget-exceeded:assistant"])
    expect(check([...base, helper(200)])).toEqual([])
    expect(assistant.budget.usdPerMonth).toBe(200)
  })

  it("restricts * containers, retired grants, meetings, skills, and output fields", () => {
    expect(check(replace(withGrants(checker, {
      connections: [{ connection: "github-product", containers: ["*"], access: "read" }]
    })))).toEqual(["wildcard-container:checker"])
    const retired = { ...checker, status: "retired" as const }
    expect(check(replace(retired))).toEqual(["retirement:checker", "retirement:checker"])
    expect(check(replace({ ...retired, grants: noGrants, retiredAt: "2026-09-22T00:00:00Z" }))).toEqual([])
    expect(check(replace({ ...checker, retiredAt: "2026-09-22T00:00:00Z" }))).toEqual(["retirement:checker"])
    for (
      const grants of [
        { connections: checker.grants.connections },
        { knowledge: ["Org/"] },
        { repositories: ["r"] },
        { personalAccounts: true },
        { hiring: { maxDepth: 0, maxChildren: 0, maxPersistent: 0 } },
        { contact: "via-assistant" as const }
      ]
    ) {
      const holding = { ...retired, grants: { ...noGrants, ...grants }, retiredAt: "2026-09-22T00:00:00Z" }
      expect(check(replace(holding)), JSON.stringify(grants)).toContain("retirement:checker")
    }
    const { meeting: _meeting, ...noMeeting } = checker
    expect(check(replace(noMeeting))).toEqual(["weekly-meeting:checker"])
    expect(check(replace(noMeeting), { ...examplePolicy, weeklyMeeting: false })).toEqual([])
    expect(check(replace({ ...noMeeting, status: "paused" }))).toEqual([])
    expect(check(base, { ...examplePolicy, skills: ["research"] })).toEqual([
      "unknown-skill:builder",
      "unknown-skill:builder",
      "unknown-skill:checker",
      "unknown-skill:lead"
    ])
    const field = checker.charter.output.fields[0]!
    const fields: Profile.Charter["output"]["fields"] = [field, field, field]
    const repeated = { ...checker, charter: { ...checker.charter, output: { ...checker.charter.output, fields } } }
    expect(check(replace(repeated))).toEqual(["duplicate-output-field:checker"])
  })
})

describe("Roster queries", () => {
  let roster: Roster.Roster

  beforeAll(async () => {
    roster = await loadExample()
  })

  it("builds rosters independent of input order", () => {
    const profiles = [...roster.profiles.values()]
    const reversed = Roster.make([...profiles].reverse(), [...roster.sources].reverse())
    expect(reversed.revision).toBe(roster.revision)
    expect([...reversed.profiles.keys()]).toEqual([...roster.profiles.keys()])
    expect(reversed.sources).toEqual(roster.sources)
    const lead = profileOf(roster, "lead")
    expect(Roster.revisionOf([lead, lead], [])).not.toBe(Roster.revisionOf([lead], []))
  })

  it("answers hiring and budget questions", () => {
    const lead = profileOf(roster, "lead")
    const research = profileOf(roster, "lead.research")
    expect(Roster.isHired(lead)).toBe(false)
    expect(Roster.isHired(research)).toBe(true)
    expect(Roster.dailyTokens(lead.budget)).toBe(300_000 * 30)
    expect(Roster.childrenOf(roster.profiles.values(), "lead").map((profile) => profile.id)).toEqual(["lead.research"])
    expect(Roster.hireChain(roster.profiles, "lead.research").map((profile) => profile.id)).toEqual([
      "lead.research",
      "lead"
    ])
    expect(Roster.hireChain(roster.profiles, "ghost")).toEqual([])
  })

  it("resolves only active principals with an active hiring chain", () => {
    const research = profileOf(roster, "lead.research")
    const lead = profileOf(roster, "lead")
    const with_ = (...changed: ReadonlyArray<Profile.Profile>) => ({
      profiles: new Map([...roster.profiles, ...changed.map((profile) => [profile.id, profile] as const)])
    })
    expect(ok(Roster.resolveActive(roster, "lead.research"))).toBe(research)
    expect(err(Roster.resolveActive(roster, "ghost"))).toMatchObject({ reason: "unknown-principal" })
    expect(err(Roster.resolveActive(with_({ ...research, status: "paused" }), "lead.research"))).toMatchObject({
      reason: "inactive",
      message: "principal lead.research is paused"
    })
    expect(err(Roster.resolveActive(with_({ ...lead, status: "retired" }), "lead.research"))).toMatchObject({
      reason: "inactive",
      message: "principal lead.research's hirer lead is retired"
    })
    expect(err(Roster.resolveActive(with_({ ...research, hiredBy: "ghost" }), "lead.research"))).toMatchObject({
      reason: "inactive",
      message: "principal lead.research has no active hiring chain"
    })
    const looped = with_({ ...lead, hiredBy: "lead.research" })
    expect(Roster.hireChain(looped.profiles, "lead.research")).toHaveLength(2)
    expect(err(Roster.resolveActive(looped, "lead.research")).reason).toBe("inactive")
  })

  it("checks results against the charter", () => {
    const builder = profileOf(roster, "builder")
    const declared = Object.fromEntries(builder.charter.output.fields.map((field) => [field.name, "x"]))
    const result: Profile.RoleResult = {
      status: "done",
      summary: "Done.",
      fields: declared,
      evidence: [{ kind: "command", ref: "pnpm test", detail: "exit 0" }],
      handoffs: [],
      escalations: [],
      decisions: []
    }
    expect(Roster.validateResult(builder, result)).toEqual([])
    expect(codes(Roster.validateResult(builder, { ...result, fields: { ...declared, extra: 1 } }))).toEqual([
      "undeclared-field:builder"
    ])
    expect(codes(Roster.validateResult(builder, { ...result, fields: {}, evidence: [] }))).toEqual([
      ...builder.charter.output.fields.map(() => "missing-field:builder"),
      "missing-evidence:builder"
    ])
    expect(Roster.validateResult(builder, { ...result, status: "blocked", fields: {}, evidence: [] })).toEqual([])
  })
})
