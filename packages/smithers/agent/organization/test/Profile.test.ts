import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { beforeAll, describe, expect, it } from "vitest"
import * as Issues from "../src/internal/issues.ts"
import * as Profile from "../src/Profile.ts"
import type * as Roster from "../src/Roster.ts"
import { loadExample, profileOf } from "./support.ts"

const accepts = <S extends Schema.Top>(schema: S, value: unknown): boolean => Schema.is(schema)(value)

const decodeFailure = async (decode: (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>, input: unknown) =>
  Issues.problems(await Effect.runPromise(Effect.flip(decode(input))))

describe("Profile schemas", () => {
  let roster: Roster.Roster

  beforeAll(async () => {
    roster = await loadExample()
  })

  it("accepts principal ids up to three hire levels and reserves owner", () => {
    for (const id of ["lead", "lead.research", "a.b-c.d.e", "x9-y"]) {
      expect(accepts(Profile.PrincipalId, id), id).toBe(true)
    }
    for (const id of ["owner", "Lead", "9lead", "lead.", ".lead", "a.b.c.d.e", "lead_x", "", "a".repeat(64)]) {
      expect(accepts(Profile.PrincipalId, id), id).toBe(false)
    }
    const long = ["a".repeat(60), "b".repeat(60), "c"].join(".")
    expect(long.length).toBeGreaterThan(Profile.maxPrincipalIdLength)
    expect(accepts(Profile.PrincipalId, long)).toBe(false)
    expect(accepts(Profile.Superior, "owner")).toBe(true)
    expect(Profile.defaultMemoryNamespace("lead.research")).toBe("agent-lead.research")
  })

  it("keeps references as names, never token-shaped values", () => {
    expect(accepts(Profile.ReferenceName, "slack-builder")).toBe(true)
    for (const value of ["xoxb-123-456", "sk-abc", "ghp_abc", "Slack", "slack--x", "a".repeat(64)]) {
      expect(accepts(Profile.ReferenceName, value), value).toBe(false)
    }
  })

  it("accepts * only as the only container, and unique entries", () => {
    const grant = { connection: "slack-team", access: "read" }
    expect(accepts(Profile.ConnectionGrant, { ...grant, containers: ["*"] })).toBe(true)
    expect(accepts(Profile.ConnectionGrant, { ...grant, containers: ["C1", "C2"] })).toBe(true)
    expect(accepts(Profile.ConnectionGrant, { ...grant, containers: ["*", "C1"] })).toBe(false)
    expect(accepts(Profile.ConnectionGrant, { ...grant, containers: ["C1", "C1"] })).toBe(false)
    expect(accepts(Profile.ConnectionGrant, { ...grant, containers: [" C1"] })).toBe(false)
  })

  it("accepts only knowledge paths inside the grammar", () => {
    for (const path of ["Org/Roles/a.md", "Org/Playbooks/", "Meeting notes/2026.md"]) {
      expect(accepts(Profile.KnowledgeGrant, path), path).toBe(true)
    }
    const refusals: ReadonlyArray<readonly [string, string]> = [
      ["", "empty"],
      ["Org/Café.md".normalize("NFD"), "not-normalized"],
      ["/etc/passwd", "absolute"],
      ["Org/*.md", "glob"],
      ["Org/!x", "glob"],
      ["Org\\x.md", "invalid-character"],
      ["C:/x.md", "invalid-character"],
      ["Org/x\u0007.md", "invalid-character"],
      ["Org/ x.md", "invalid-character"],
      ["Org//x.md", "empty-segment"],
      ["Org/../x.md", "dot-segment"],
      ["Org/./x.md", "dot-segment"],
      ["Org/.git/", "dot-segment"]
    ]
    for (const [path, refusal] of refusals) {
      expect(accepts(Profile.KnowledgeGrant, path), path).toBe(false)
      expect(Schema.decodeUnknownExit(Profile.KnowledgeGrant)(path)._tag).toBe("Failure")
      expect(JSON.stringify(Schema.decodeUnknownExit(Profile.KnowledgeGrant)(path))).toContain(refusal)
    }
  })

  it("checks lines, paragraphs, versions, seats, and instants", () => {
    expect(accepts(Profile.Line, "One line.")).toBe(true)
    for (const line of ["", " padded", "two\nlines", "x".repeat(2001)]) expect(accepts(Profile.Line, line)).toBe(false)
    expect(accepts(Profile.Paragraph, "First.\nSecond.")).toBe(true)
    expect(accepts(Profile.Paragraph, "\nFirst.")).toBe(false)
    expect(accepts(Profile.Version, "1.20.0")).toBe(true)
    for (const version of ["1.0", "01.0.0", "1.0.0-rc.1"]) expect(accepts(Profile.Version, version)).toBe(false)
    expect(accepts(Profile.Seat, "openai:gpt-6-sol")).toBe(true)
    expect(accepts(Profile.Seat, "open ai")).toBe(false)
    expect(accepts(Profile.Instant, "2026-09-25T17:00:00Z")).toBe(true)
    expect(accepts(Profile.Instant, "2026-09-25T17:00:00.123Z")).toBe(true)
    for (const instant of ["2026-02-30T00:00:00Z", "2026-09-25T25:00:00Z", "2026-09-25T17:00:00+02:00", "2026-09-25"]) {
      expect(accepts(Profile.Instant, instant), instant).toBe(false)
    }
    expect(accepts(Profile.BankName, "agent-lead.research")).toBe(true)
    expect(accepts(Profile.BankName, "team-lead")).toBe(false)
    expect(accepts(Profile.FieldName, "revision")).toBe(true)
    expect(accepts(Profile.FieldName, "9lives")).toBe(false)
    expect(accepts(Profile.SkillName, "code-review")).toBe(true)
    expect(accepts(Profile.SkillName, "Code_Review")).toBe(false)
  })

  it("decodes the example profiles and refuses unknown keys", async () => {
    const builder = profileOf(roster, "builder")
    expect(await Effect.runPromise(Profile.decodeProfile(builder))).toEqual(builder)
    expect(await decodeFailure(Profile.decodeProfile, { ...builder, notes: "x" })).toEqual([
      { field: "notes", problem: "is not a recognized key" }
    ])
    expect(await decodeFailure(Profile.decodeGrants, { ...builder.grants, tools: ["memory", "memory"] })).toEqual([
      { field: "tools", problem: "tools must be unique" }
    ])
    expect(await decodeFailure(Profile.decodeGrants, { ...builder.grants, tools: ["shell"] })).toEqual([
      { field: "tools[0]", problem: "is not one of the accepted values" }
    ])
  })

  it("decodes task contracts and role results", async () => {
    const task = {
      id: "task-17",
      objective: "Fix the flaky test.",
      inputs: ["The failing run."],
      acceptance: ["The test passes ten times in a row."],
      evidence: ["Command receipts."],
      deadline: "2026-10-01T17:00:00Z",
      budgetTokens: 50_000,
      requestedBy: "lead",
      conversation: { provider: "slack", container: "C0TEAM", thread: "1726.0001" }
    }
    expect(await Effect.runPromise(Profile.decodeTaskContract(task))).toEqual(task)
    expect(await decodeFailure(Profile.decodeTaskContract, { ...task, budgetTokens: 0 })).toEqual([
      { field: "budgetTokens", problem: "expected a value greater than 0" }
    ])
    const result = {
      status: "done",
      summary: "Fixed.",
      fields: { revision: "abc123", checks: [{ command: "pnpm test", exit: 0 }] },
      evidence: [{ kind: "command", ref: "pnpm test", detail: "exit 0" }],
      handoffs: [{ to: "checker", objective: "Reproduce.", inputs: ["abc123"] }],
      escalations: [{ to: "parent", reason: "None needed." }],
      decisions: [{ question: "Ship?", options: ["yes", "no"] }]
    }
    expect(await Effect.runPromise(Profile.decodeRoleResult(result))).toEqual(result)
    expect(await decodeFailure(Profile.decodeRoleResult, { ...result, status: "finished" })).toEqual([
      { field: "status", problem: "is not one of the accepted values" }
    ])
  })
})

describe("value-free schema problems", () => {
  it("names the field and never echoes the value", async () => {
    const secret = "xoxb-000000000000-secret-token"
    const problems = await decodeFailure(Profile.decodeProfile, {
      id: "builder",
      identities: { slack: secret }
    })
    const rendered = Issues.summary(problems)
    expect(rendered).not.toContain(secret)
    expect(rendered).not.toContain("secret")
    expect(problems.length).toBeLessThanOrEqual(5)
  })

  it("renders root and union problems", async () => {
    expect(Issues.summary(await decodeFailure(Schema.decodeUnknownEffect(Profile.Superior), 5))).toContain("value ")
    const failure = await Effect.runPromise(Effect.flip(Schema.decodeUnknownEffect(Profile.Superior)("Owner")))
    expect(Issues.problems(failure).length).toBeGreaterThan(0)
    const union = Schema.Union([Schema.Struct({ a: Schema.String }), Schema.Struct({ b: Schema.Number })])
    expect(await decodeFailure(Schema.decodeUnknownEffect(union), { c: 1 })).not.toEqual([])
    expect(await decodeFailure(Schema.decodeUnknownEffect(Schema.Never), 1)).toEqual([
      { field: "", problem: "has the wrong type" }
    ])
    const unannotated = Schema.String.check(Schema.makeFilter(() => false))
    expect(await decodeFailure(Schema.decodeUnknownEffect(unannotated), "x")).toEqual([
      { field: "", problem: "is invalid" }
    ])
  })
})
