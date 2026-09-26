/**
 * The organization configuration pages: what each accepts, what it refuses,
 * that a refusal never repeats a value, and how `load` finds the pages the
 * organization page names inside the wiki root and nowhere else.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, PlatformError } from "effect"
import type * as Path from "effect/Path"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Config from "../src/Config.ts"

const organizationPage = `---
organization: example-org
version: 1.0.0
owner: owner                      # the reserved principal
assistant: assistant
rosterDir: Org
commonFile: Org/Common Operating Instructions.md
skillsDir: Org/Skills
casesDir: Org/Cases
policyFile: Org/Policy/Gates.md
connectionsFile: Org/Connections.md
meetingsFile: Org/Meetings.md
weeklyMeeting: true
seats:
  default: openai:gpt-6-sol
  light: openai:gpt-6-luna
judge: none
vm:
  provider: microsandbox
  image: null
  cpus: 2
  memoryMib: 2048
  maxConcurrentVMs: 2
limits:
  usdPerMonth: null
wiki:
  generatedDir: Org/Runs
  statusFile: Org/Status.md
  commit: false
  push: false
---

# Organization

The host reads only the frontmatter.
`

const gatesPage = (gates: string) =>
  `---
revision: "2026-09-25.1"
gates: ${gates}
---

# Gates
`

const connectionsPage = `---
connections:
  - id: chat
    provider: slack
    principal: assistant
    personal: false
    credential: chat-bot-token
    appCredential: chat-app-token
    scopes: [chat:write, im:history]
    appScopes: [connections:write]
    containerAliases:
      team: null
      owner-dm: D0123456789
    status: not-connected
  - id: calendar-owner
    provider: google-calendar
    label: Owner calendar
    principal: assistant
    personal: true
    credential: calendar-owner-oauth
    scopes: ["https://www.googleapis.com/auth/calendar.events"]
    containers: [primary]
identities:
  email-assistant: { address: null, status: not-provisioned }
---

# Connections
`

const meetingsPage = (inputs: string) =>
  `---
seriesId: weekly-one-on-ones
weekday: 5
slotMinutes: 30
order: [lead, builder]
${inputs}
calendarConnection: calendar-owner
slackDelivery: direct message
---

# Meetings
`

const unset = "timezone: null\nstart: null\nfirstDate: null"

const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

const flip = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) => run(Effect.flip(effect))

/** The Node filesystem with the named methods failing for paths ending in `suffix`. */
const faulty = (methods: ReadonlyArray<string>, suffix: string) =>
  Layer.mergeAll(
    Layer.effect(
      FileSystem.FileSystem,
      Effect.map(FileSystem.FileSystem, (real) => {
        const wrapped: Record<string, unknown> = { ...real }
        for (const method of methods) {
          const original = real[method as keyof typeof real] as (...args: ReadonlyArray<unknown>) => unknown
          wrapped[method] = (...args: ReadonlyArray<unknown>) =>
            String(args[0]).endsWith(suffix)
              ? Effect.fail(
                PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method, description: "injected" })
              )
              : original(...args)
        }
        return wrapped as unknown as FileSystem.FileSystem
      })
    ).pipe(Layer.provide(NodeFileSystem.layer)),
    NodePath.layer
  )

const wiki = (pages: Record<string, string>): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "organization-config-")))
  for (const [relative, text] of Object.entries(pages)) {
    mkdirSync(dirname(join(root, relative)), { recursive: true })
    writeFileSync(join(root, relative), text)
  }
  return root
}

const fullWiki = () =>
  wiki({
    "Org/Organization.md": organizationPage,
    "Org/Policy/Gates.md": gatesPage("[]"),
    "Org/Connections.md": connectionsPage,
    "Org/Meetings.md": meetingsPage(unset)
  })

describe("the organization page", () => {
  it("parses every setting", async () => {
    const organization = await run(Config.parseOrganization("Org/Organization.md", organizationPage))
    expect(organization).toMatchObject({
      organization: "example-org",
      owner: "owner",
      assistant: "assistant",
      rosterDir: "Org",
      seats: { default: "openai:gpt-6-sol", light: "openai:gpt-6-luna" },
      judge: "none",
      vm: { provider: "microsandbox", image: null, cpus: 2, memoryMib: 2048, maxConcurrentVMs: 2 },
      limits: { usdPerMonth: null },
      wiki: { generatedDir: "Org/Runs", statusFile: "Org/Status.md", commit: false, push: false }
    })
  })

  it("leaves guest networking off unless the page turns it on", async () => {
    const off = await run(Config.parseOrganization("o.md", organizationPage))
    expect(off.vm.network).toBeUndefined()
    const on = await run(
      Config.parseOrganization(
        "o.md",
        organizationPage.replace("  maxConcurrentVMs: 2\n", "  maxConcurrentVMs: 2\n  network: true\n")
      )
    )
    expect(on.vm.network).toBe(true)
  })

  it("accepts Windows line endings", async () => {
    const organization = await run(Config.parseOrganization("o.md", organizationPage.replaceAll("\n", "\r\n")))
    expect(organization.assistant).toBe("assistant")
  })

  it("refuses unknown keys by name", async () => {
    const error = await flip(
      Config.parseOrganization("o.md", organizationPage.replace("judge: none", "judge: none\nroster: Org/"))
    )
    expect(error).toMatchObject({
      code: "schema",
      path: "o.md",
      field: "roster",
      message: "roster is not a recognized key"
    })
  })

  it("refuses a path that leaves the wiki and a seat list without a default", async () => {
    const escaping = await flip(
      Config.parseOrganization("o.md", organizationPage.replace("rosterDir: Org", "rosterDir: ../Org"))
    )
    expect(escaping).toMatchObject({ code: "schema", field: "rosterDir" })
    const noDefault = await flip(
      Config.parseOrganization("o.md", organizationPage.replace("  default: openai:gpt-6-sol\n", ""))
    )
    expect(noDefault).toMatchObject({ code: "schema", field: "seats", message: "seats must name a default seat" })
  })

  it("refuses a page with no frontmatter or broken YAML without quoting it", async () => {
    expect(await flip(Config.parseOrganization("o.md", "# no settings"))).toMatchObject({
      code: "frontmatter",
      message: "a page starts with --- frontmatter"
    })
    const broken = await flip(Config.parseOrganization("o.md", "---\nsecret: [sk-live-value\n---\n"))
    expect(broken.code).toBe("frontmatter")
    expect(broken.message).not.toContain("sk-live-value")
  })
})

describe("the gate policy page", () => {
  it("parses an empty policy: autonomous by default", async () => {
    expect(await run(Config.parseGatePolicy("g.md", gatesPage("[]")))).toEqual({
      revision: "2026-09-25.1",
      gates: []
    })
  })

  it("parses Approval and Review gates", async () => {
    const policy = await run(Config.parseGatePolicy(
      "g.md",
      gatesPage(`
  - at: { boundary: release, target: "*" }
    spec: { _tag: Review, id: release-review, reviewer: checker }
  - at: { boundary: tool, target: organization/hire }
    spec: { _tag: Approval, id: hire-approval, approver: owner, prompt: "Hire?", timeoutMs: 172800000 }`)
    ))
    expect(policy.gates.map((gate) => gate.spec._tag)).toEqual(["Review", "Approval"])
  })

  it("refuses every kind that cannot run yet, naming the entry", async () => {
    const kinds = [
      "{ _tag: Budget, id: cap, principal: builder, tokens: 100000 }",
      "{ _tag: Concurrency, id: serial, key: role/security, limit: 1, retryAfterMs: 60000 }",
      "{ _tag: Window, id: window, cron: \"0 6 * * 5\", timezone: UTC, openForMinutes: 720 }",
      "{ _tag: Condition, id: healthy, signal: slack-healthy }"
    ]
    for (const spec of kinds) {
      const error = await flip(Config.parseGatePolicy(
        "g.md",
        gatesPage(`
  - at: { boundary: task, target: builder }
    spec: { _tag: Approval, id: first, approver: owner, prompt: "Go?" }
  - at: { boundary: task, target: builder }
    spec: ${spec}`)
      ))
      expect(error.code).toBe("unsupported")
      expect(error.field).toBe("gates[1].spec")
      expect(error.message).toMatch(/^(Budget|Concurrency|Window|Condition) gates are not yet supported/)
    }
  })

  it("refuses unknown keys and unknown kinds", async () => {
    const extra = await flip(Config.parseGatePolicy("g.md", gatesPage("[]").replace("gates:", "owner: x\ngates:")))
    expect(extra).toMatchObject({ code: "schema", field: "owner" })
    const unknown = await flip(Config.parseGatePolicy(
      "g.md",
      gatesPage(`[{ at: { boundary: task, target: x }, spec: { _tag: Pray, id: p } }]`)
    ))
    expect(unknown.code).toBe("schema")
  })
})

describe("the connections page", () => {
  it("parses reference names only", async () => {
    const connections = await run(Config.parseConnections("c.md", connectionsPage))
    expect(connections.connections.map((connection) => connection.credential)).toEqual([
      "chat-bot-token",
      "calendar-owner-oauth"
    ])
    expect(connections.connections[0]!.containerAliases).toEqual({ team: null, "owner-dm": "D0123456789" })
  })

  it("refuses a pasted token without repeating it", async () => {
    const secret = "xoxb-1234567890-abcdefghij"
    const error = await flip(Config.parseConnections("c.md", connectionsPage.replace("chat-bot-token", secret)))
    expect(error).toMatchObject({ code: "schema", field: "connections[0].credential" })
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it("refuses duplicate connection ids", async () => {
    const error = await flip(Config.parseConnections("c.md", connectionsPage.replace("id: calendar-owner", "id: chat")))
    expect(error).toMatchObject({ code: "schema", message: "connections connection ids must be unique" })
  })
})

describe("the meetings page", () => {
  it("has no weekly request until the owner sets every input", async () => {
    const meetings = await run(Config.parseMeetings("m.md", meetingsPage(unset)))
    expect(meetings.timezone).toBeNull()
    expect(Config.weeklyRequest(meetings)).toBeUndefined()
  })

  it("yields the weekly request once the inputs are set", async () => {
    const meetings = await run(Config.parseMeetings(
      "m.md",
      meetingsPage("timezone: America/Los_Angeles\nstart: \"09:00\"\nfirstDate: \"2026-10-02\"")
    ))
    expect(Config.weeklyRequest(meetings)).toEqual({
      seriesId: "weekly-one-on-ones",
      timezone: "America/Los_Angeles",
      weekday: 5,
      start: "09:00",
      slotMinutes: 30,
      order: ["lead", "builder"],
      firstDate: "2026-10-02"
    })
  })
})

describe("loading from the wiki", () => {
  it("loads every page the organization page names", async () => {
    const loaded = await run(Config.load(fullWiki()))
    expect(loaded.organization.assistant).toBe("assistant")
    expect(loaded.policy).toEqual({ revision: "2026-09-25.1", gates: [] })
    expect(loaded.connections?.connections).toHaveLength(2)
    expect(loaded.meetings?.seriesId).toBe("weekly-one-on-ones")
  })

  it("treats pages the organization page does not name as absent, with an empty policy", async () => {
    const minimal = organizationPage
      .replace("policyFile: Org/Policy/Gates.md\n", "")
      .replace("connectionsFile: Org/Connections.md\n", "")
      .replace("meetingsFile: Org/Meetings.md\n", "")
    const loaded = await run(Config.load(wiki({ "Config/Org.md": minimal }), "Config/Org.md"))
    expect(loaded.policy.gates).toEqual([])
    expect(loaded.connections).toBeUndefined()
    expect(loaded.meetings).toBeUndefined()
  })

  it("refuses a policy the host cannot enforce", async () => {
    const root = fullWiki()
    writeFileSync(
      join(root, "Org/Policy/Gates.md"),
      gatesPage("[{ at: { boundary: task, target: x }, spec: { _tag: Budget, id: cap, principal: x, tokens: 1 } }]")
    )
    expect(await flip(Config.load(root))).toMatchObject({ code: "unsupported", path: "Org/Policy/Gates.md" })
  })

  it("refuses a missing root, a missing page, and a path outside the grammar", async () => {
    expect(await flip(Config.load(join(tmpdir(), "organization-config-missing-root")))).toMatchObject({
      code: "read",
      path: "."
    })
    expect(await flip(Config.load(wiki({})))).toMatchObject({ code: "read", path: "Org/Organization.md" })
    expect(await flip(Config.load(fullWiki(), "../Organization.md"))).toMatchObject({ code: "confinement" })
  })

  it("refuses a page that resolves outside the wiki root", async () => {
    const outside = wiki({ "Gates.md": gatesPage("[]") })
    const root = fullWiki()
    const target = join(root, "Org/Policy/Gates.md")
    unlinkSync(target)
    symlinkSync(join(outside, "Gates.md"), target)
    expect(await flip(Config.load(root))).toMatchObject({ code: "confinement", path: "Org/Policy/Gates.md" })
  })

  it("refuses a directory and an oversized page", async () => {
    const root = fullWiki()
    unlinkSync(join(root, "Org/Meetings.md"))
    mkdirSync(join(root, "Org/Meetings.md"))
    expect(await flip(Config.load(root))).toMatchObject({ code: "read", message: "is not a regular file" })
    const large = fullWiki()
    writeFileSync(join(large, "Org/Connections.md"), `${connectionsPage}${"x".repeat(Config.maxPageBytes)}`)
    expect(await flip(Config.load(large))).toMatchObject({ code: "too-large", path: "Org/Connections.md" })
  })

  it("reports a page that cannot be inspected or read", async () => {
    const root = fullWiki()
    const failing = (methods: ReadonlyArray<string>) =>
      Effect.runPromise(Effect.flip(Config.load(root)).pipe(Effect.provide(faulty(methods, "Connections.md"))))
    expect(await failing(["stat"])).toMatchObject({ code: "read", message: "the page could not be read" })
    expect(await failing(["readFileString"])).toMatchObject({ code: "read", message: "the page could not be read" })
  })
})
