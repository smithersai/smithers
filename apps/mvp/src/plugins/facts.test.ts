// The trust boundaries a plugin meets at load (decision 0017; docs/features/plugins.md#trust-boundaries), each a manifest
// the real loader refuses against the app's real registry and core queries: system flows can't be owned or replaced,
// a plugin reaches only flows it declares within its ceiling, nobody sees an action the server refuses them, and
// secrets stay opaque.
import { Load } from "@smthrs/plugin"
import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import factory from "../../plugins/factory/plugin.json" with { type: "json" }
import queue from "../../plugins/queue/plugin.json" with { type: "json" }
import { registry } from "../flows/registry"
import { POINTS } from "./contract"
import { factsOf, hostFacts, ungranted } from "./facts"

const facts = hostFacts()

/** A small valid manifest, changed by `change`. */
const manifest = (change: (base: Record<string, unknown>) => Record<string, unknown> = (base) => base) =>
  change({
    apiVersion: 1,
    id: "probe",
    version: "0.1.0",
    title: "Probe",
    description: "A plugin the tests load.",
    requires: { api: "^1.0.0" },
    capabilities: [],
    uses: ["app/navigate"],
    contributes: {
      commands: [{ id: "probe/open", flow: "app/navigate", args: { to: "/app" }, title: "Probe", minimum: "anyone" }],
    },
  })

const load = (candidate: Load.Candidate, host: Load.HostFacts = facts) => Effect.runSync(Load.load(host, [candidate]))
const reasons = (loaded: Load.Loaded) => loaded.refused.map((refusal) => refusal.reason)

describe("the host's facts", () => {
  test("every registry flow is the core's, with its minimum and whether only a person runs it", () => {
    expect(facts.catalog.size).toBe(Object.keys(registry).length)
    expect(facts.catalog.get("run/answer")).toMatchObject({ minimum: "member", personOnly: true, system: true, capabilities: [] })
    expect(facts.catalog.get("app/navigate")).toMatchObject({ minimum: "anyone", personOnly: false })
    expect(facts.catalog.get("app/web/open")?.minimum).toBe("member")
    expect(Object.keys((facts.catalog.get("app/navigate")!.payload as { properties: object }).properties)).toEqual(["to"])
    expect(facts.points).toEqual(POINTS)
    for (const tier of ["built-in", "repository", "personal"] as const) {
      expect(facts.tierCap[tier]("net:get")).toBe(true)
      expect(facts.tierCap[tier]("secret:read")).toBe(false)
    }
    expect([...facts.queries.keys()]).toEqual(["core/waits", "core/bug-reports", "core/feeds", "core/feed"])
  })

  test("a flow whose payload isn't a struct has no payload facts", () => {
    expect(factsOf({ flow: { ...registry["app/navigate"].flow, payloadSchema: {} } as never }).payload).toBeUndefined()
  })

  test("a declaration's own capabilities are its facts", () => {
    expect(factsOf({ flow: { ...registry["app/navigate"].flow, capabilities: ["net:get"] } as never }).capabilities).toEqual(["net:get"])
  })

  test("a host built over another catalog reads that one", () => {
    expect([...hostFacts({ "app/navigate": registry["app/navigate"] }).catalog.keys()]).toEqual(["app/navigate"])
  })

  test("the queue loads with nothing refused", () => {
    expect(load({ tier: "built-in", manifest: queue }).refused).toEqual([])
  })

  test("the factory loads with nothing refused: its views, its repository tab and its commands", () => {
    const loaded = load({ tier: "built-in", manifest: factory })
    expect(loaded.refused).toEqual([])
    expect(loaded.contributions.views.map((view) => view.path)).toEqual([
      "", "for-you", "failures", "reviews", "implementation", "commits", "agents", "media", "docs", "queue",
    ])
    expect(loaded.contributions.views.every((view) => view.scope === "repository")).toBe(true)
    expect(loaded.contributions.slots.map((slot) => slot.slot)).toEqual(["repo.tabs"])
    expect(loaded.contributions.commands.map((command) => command.slash?.name)).toEqual(["factory", "lanes", "decide"])
  })
})

describe("trust boundaries", () => {
  test("a small manifest loads", () => {
    expect(load({ tier: "built-in", manifest: manifest() }).refused).toEqual([])
  })

  test("system flows can't be overridden: owning a core flow is refused, even on a host that takes owned flows", () => {
    const host = { ...facts, points: [...POINTS, "flows" as const] }
    const owning = { tier: "built-in" as const, manifest: manifest((base) => ({ ...base, flows: ["flows"] })) }
    for (const tag of ["run/answer", "app/navigate"]) {
      const loaded = load({ ...owning, flows: [{ ...facts.catalog.get(tag)!, tag, modelInvocable: false }] }, host)
      expect(reasons(loaded), tag).toEqual(expect.arrayContaining([expect.stringMatching(/^(conflict|reserved)$/)]))
      expect(loaded.contributions.plugins).toEqual([])
    }
  })

  test("a plugin's slash command never shadows the core's own: /status is the core's", () => {
    expect(facts.slash).toContain("status")
    const command = (name: string) =>
      reasons(load({
        tier: "built-in",
        manifest: manifest((base) => ({
          ...base,
          contributes: { commands: [{ id: "probe/open", flow: "app/navigate", args: { to: "/app" }, title: "Probe", minimum: "anyone", slash: { name } }] },
        })),
      }))
    expect(command("status")).toEqual(["conflict"])
    expect(command("lanes")).toEqual([])
  })

  test("a reserved namespace is refused for a plugin's id", () => {
    for (const id of ["app", "core", "secret", "run", "system"]) {
      expect(reasons(load({ tier: "built-in", manifest: manifest((base) => ({ ...base, id })) })), id).toContain("reserved")
    }
  })

  test("a contribution may name only a flow it declares", () => {
    const loaded = load({ tier: "built-in", manifest: manifest((base) => ({ ...base, uses: [] })) })
    expect(reasons(loaded)).toEqual(["undeclared_use"])
    expect(reasons(load({ tier: "built-in", manifest: manifest((base) => ({ ...base, uses: ["no/such"] })) }))).toContain("undeclared_use")
  })

  test("nobody sees an action the server refuses them: a Guest's view can't answer", () => {
    const view = { ...(queue.contributes.views[0] as object), minimum: "guest" }
    const lowered = { ...queue, contributes: { ...queue.contributes, views: [view] } }
    expect(reasons(load({ tier: "built-in", manifest: lowered }))).toContain("minimum_below_flow")
  })

  test("secrets stay opaque: no tier holds a secret capability without a grant", () => {
    for (const tier of ["built-in", "repository", "personal"] as const) {
      expect(reasons(load({ tier, manifest: manifest((base) => ({ ...base, capabilities: ["secret:read"] })) })), tier)
        .toContain("capability_exceeded")
    }
    expect(ungranted("secret")).toBe(true)
    expect(ungranted("secret:read")).toBe(true)
    expect(ungranted("secrets-viewer:read")).toBe(false)
    expect(ungranted("net:get")).toBe(false)
  })

  test("secrets stay opaque: an event can't ask the person for one", () => {
    const view = queue.contributes.views[0]!
    const asking = {
      ...queue,
      contributes: {
        ...queue.contributes,
        views: [{ ...view, events: [...view.events, { name: "login", payload: { type: "object", properties: { token: { type: "string" } } }, flow: "app/navigate", args: { to: "/app" } }] }],
      },
    }
    expect(reasons(load({ tier: "built-in", manifest: asking }))).toContain("secret_field")
  })

  test("a point this host doesn't implement is refused, never ignored", () => {
    const cards = manifest((base) => ({ ...base, contributes: { cards: [{ kind: "probe/card", payload: {}, sizes: ["inline"], render: { kind: "blocks", blocks: [] } }] } }))
    expect(reasons(load({ tier: "built-in", manifest: cards }))).toEqual(["unsupported_point"])
  })

  test("only a compiled plugin draws with React in the app's realm", () => {
    expect(reasons(load({ tier: "repository", manifest: queue }))).toContain("unsupported_point")
  })
})
