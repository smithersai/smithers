import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"
import * as Config from "../src/Config.ts"
import * as Frontmatter from "../src/internal/frontmatter.ts"
import * as Prompt from "../src/Prompt.ts"
import * as Roster from "../src/Roster.ts"
import * as Skills from "../src/Skills.ts"
import { ok, run } from "./support.ts"

// The public example organization shipped with the package, not the test
// fixture. Its wiki root is `example/`, and every page lives under `Org/`.
const root = fileURLToPath(new URL("../example/", import.meta.url))

describe("example/Org", () => {
  let config: Config.Loaded
  let roster: Roster.Roster
  let pack: Skills.Pack
  let casesDir: string

  beforeAll(async () => {
    config = await run(Config.load(root))
    roster = await run(Roster.load(join(root, config.organization.rosterDir)))
    pack = await run(Skills.loadPack(join(root, config.organization.skillsDir!)))
    casesDir = join(root, config.organization.casesDir!)
  })

  it("loads every configuration page the organization page names", () => {
    expect(config.organization).toMatchObject({
      owner: "owner",
      assistant: "assistant",
      rosterDir: "Org",
      judge: "none",
      vm: { provider: "microsandbox", maxConcurrentVMs: 2 }
    })
    expect(config.policy.gates).toEqual([])
    expect(config.connections!.connections.map((connection) => connection.id)).toEqual([
      "chat-assistant",
      "chat-lead",
      "calendar-owner"
    ])
    // The meeting time stays unset until the owner chooses it.
    expect(config.meetings).toMatchObject({ timezone: null, start: null, firstDate: null })
    expect(Config.weeklyRequest(config.meetings!)).toBeUndefined()
  })

  it("agrees with the roster: the assistant, meeting order, and granted connections exist", () => {
    const assistant = roster.profiles.get(config.organization.assistant)!
    expect(assistant.grants.personalAccounts).toBe(true)
    expect([...config.meetings!.order].sort()).toEqual([...roster.profiles.keys()].sort())
    const configured = new Map(config.connections!.connections.map((connection) => [connection.id, connection]))
    for (const profile of roster.profiles.values()) {
      for (const grant of profile.grants.connections) {
        const connection = configured.get(grant.connection)
        expect(connection, `${profile.id} ${grant.connection}`).toBeDefined()
        // Only the assistant is granted a personal connection.
        if (connection!.personal) expect(profile.id).toBe(config.organization.assistant)
      }
    }
  })

  it("loads the four generic roles and validates with no violations", () => {
    expect([...roster.profiles.keys()]).toEqual(["assistant", "builder", "checker", "lead"])
    expect([...pack.skills.keys()]).toEqual(["evidence-receipts"])
    const policy = { weeklyMeeting: config.organization.weeklyMeeting ?? true, skills: [...pack.skills.keys()] }
    expect(Roster.validate([...roster.profiles.values()], policy)).toEqual([])
  })

  it("has a case file for every case a role references", () => {
    const files = readdirSync(casesDir).filter((name) => name.endsWith(".md")).sort()
    const referenced = [...roster.profiles.values()].flatMap((profile) =>
      profile.cases.map((name) => ({ name, principal: profile.id }))
    )
    expect(files).toEqual(referenced.map(({ name }) => `${name}.md`).sort())
    for (const { name, principal } of referenced) {
      const split = Frontmatter.split(readFileSync(join(casesDir, `${name}.md`), "utf8"))
      const parsed = Frontmatter.parse(split.frontmatter!, "core")
      expect(parsed.ok, name).toBe(true)
      const fields = (parsed as { readonly value: Record<string, unknown> }).value
      expect(fields.id, name).toBe(name)
      expect(fields.principal, name).toBe(principal)
      // A case expecting a done result names exactly the role's declared output fields.
      const expected = fields.expect as { readonly status: string; readonly fields: ReadonlyArray<string> }
      if (expected.status === "done") {
        expect(expected.fields, name).toEqual(
          roster.profiles.get(principal)!.charter.output.fields.map((field) => field.name)
        )
      }
    }
  })

  it("composes a prompt for every role from the example pack", () => {
    for (const profile of roster.profiles.values()) {
      const composed = ok(Prompt.compose({
        common: { id: "common", version: "1", text: "Follow the charter." },
        profile,
        task: { id: "t-1", objective: "Do the task.", inputs: [], acceptance: [], evidence: [], requestedBy: "owner" },
        skills: ok(Skills.select(pack, profile.skills)),
        context: []
      }))
      expect(composed.parts.map((part) => part.kind), profile.id).toEqual(["common", "charter", "skill", "task"])
    }
  })
})
