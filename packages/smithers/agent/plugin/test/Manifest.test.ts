import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Manifest from "../src/Manifest.ts"
import { minimal, queueManifest } from "./support/hostFacts.ts"

const refusal = (effect: Effect.Effect<unknown, unknown>) => Effect.runPromise(Effect.flip(effect))

describe("Manifest.decode", () => {
  it("decodes the printed queue manifest", async () => {
    const manifest = await Effect.runPromise(Manifest.decode(queueManifest()))
    expect(manifest.id).toBe("queue")
    expect(manifest.contributes?.keybindings).toHaveLength(7)
  })

  it("refuses an unknown field, naming its path", async () => {
    const manifest = queueManifest()
    manifest.contributes.views[0].colour = "red"
    expect(await refusal(Manifest.decode(manifest))).toMatchObject({
      _tag: "plugin/Refusal",
      reason: "invalid",
      path: "contributes.views[0].colour"
    })
  })

  it("names the failing field of a nested value", async () => {
    const manifest = queueManifest()
    manifest.contributes.views[0].scope = "everywhere"
    expect(await refusal(Manifest.decode(manifest))).toMatchObject({
      reason: "invalid",
      path: "contributes.views[0].scope"
    })
  })

  it("refuses a keybinding that carries both a command and an event", async () => {
    const manifest = queueManifest()
    manifest.contributes.keybindings[0] = {
      key: "x",
      command: "queue/open",
      event: "next",
      when: "view == queue/queue"
    }
    const refused = await refusal(Manifest.decode(manifest)) as Manifest.Manifest & { path: string }
    expect(refused).toMatchObject({ reason: "invalid" })
    expect(refused.path.startsWith("contributes.keybindings[0]")).toBe(true)
  })

  it("refuses a tap that carries both a flow and a value", async () => {
    const refused = await refusal(
      Manifest.decode(minimal("tapper", { contributes: { taps: [{ hook: "tapper/h", flow: "tapper/f", value: 1 }] } }))
    )
    expect(refused).toMatchObject({ reason: "invalid" })
  })

  it("refuses a value that is not inert JSON, or nests past the limit, without running it", async () => {
    let read = false
    const accessor = Object.defineProperty({ ...minimal("sneaky") }, "title", {
      enumerable: true,
      get: () => {
        read = true
        return "Sneaky"
      }
    })
    expect(await refusal(Manifest.decode(accessor))).toMatchObject({ reason: "invalid", path: "title" })
    expect(read).toBe(false)

    let nested: unknown = 1
    for (let depth = 0; depth <= Manifest.maximumDepth; depth++) nested = [nested]
    expect(await refusal(Manifest.decode({ ...minimal("deep"), $defs: { Deep: nested } }))).toMatchObject({
      reason: "invalid"
    })
    const refused = await refusal(Manifest.decode({ ...minimal("deep"), uses: [{ a: 1 }] })) as { path: string }
    expect(refused.path).toBe("uses[0]")
  })

  it("refuses a module or flow path that could leave the plugin root", async () => {
    const view = (module: string) => ({
      ...minimal("paths"),
      contributes: {
        views: [{
          id: "paths/v",
          title: "V",
          scope: "app",
          path: "",
          sizes: ["full"],
          minimum: "anyone",
          render: { kind: "view", module }
        }]
      }
    })
    for (
      const module of [
        "../x.tsx",
        "a/../../x",
        "/abs.tsx",
        "https://x.test/v.tsx",
        "c:/v.tsx",
        "a\\b.tsx",
        "a//b",
        "a/",
        "./a",
        "",
        "."
      ]
    ) {
      const refused = await refusal(Manifest.decode(view(module))) as { reason: string; path: string }
      expect(refused.reason, module).toBe("invalid")
      expect(refused.path.startsWith("contributes.views[0].render"), module).toBe(true)
    }
    for (const module of ["views/queue.tsx", ".well-known/x", "a/b..c/d_e@1+2-3.tsx"]) {
      expect((await Effect.runPromise(Manifest.decode(view(module)))).id, module).toBe("paths")
    }
    expect(await refusal(Manifest.decode({ ...minimal("paths"), flows: ["../flows"] }))).toMatchObject({
      reason: "invalid",
      path: "flows[0]"
    })
  })

  it("quotes a key that is not an identifier in the path", async () => {
    const refused = await refusal(
      Manifest.decode({ ...minimal("keys"), userOnly: { "not a tag": "Because." } })
    ) as { path: string }
    expect(refused.path).toBe(`userOnly["not a tag"]`)
  })

  it("bounds the path and detail of a refused over-long key or accessor", async () => {
    const accessor = Object.defineProperty({ ...minimal("keys") }, "A".repeat(2_000_000), {
      get: () => "x",
      enumerable: true
    })
    for (
      const input of [
        { ...minimal("keys"), userOnly: { ["k".repeat(257)]: "Because." } },
        { ...minimal("keys"), userOnly: { ["k".repeat(1_000_000)]: "Because." } },
        { ...minimal("keys"), userOnly: { ["k".repeat(1_000_000)]: accessor } },
        accessor
      ]
    ) {
      const refused = await refusal(Manifest.decode(input)) as { reason: string; path: string; detail: string }
      expect(refused.reason).toBe("invalid")
      expect(refused.path.length).toBeLessThan(128)
      expect(refused.detail.length).toBeLessThan(128)
    }
  })

  it("refuses a flow tag past 256 characters", async () => {
    expect(await refusal(Manifest.decode({ ...minimal("long"), uses: [`a/${"b".repeat(255)}`] }))).toMatchObject({
      reason: "invalid",
      path: "uses[0]"
    })
    expect((await Effect.runPromise(Manifest.decode({ ...minimal("long"), uses: [`a/${"b".repeat(254)}`] }))).uses)
      .toHaveLength(1)
  })

  it("never echoes the refused value in the detail", async () => {
    const refused = await refusal(Manifest.decode({ ...minimal("long"), id: "secret-looking-value-".repeat(10) })) as {
      detail: string
    }
    expect(refused.detail).not.toContain("secret-looking-value")
  })
})

describe("Manifest.parse", () => {
  it("parses JSON text", async () => {
    const manifest = await Effect.runPromise(Manifest.parse(JSON.stringify(queueManifest())))
    expect(manifest.title).toBe("Queue")
  })

  it("refuses text over the byte limit before parsing it", async () => {
    const text = JSON.stringify({ ...minimal("big"), description: "é".repeat(Manifest.maximumManifestBytes / 2) })
    const refused = await refusal(Manifest.parse(text)) as { reason: string; path?: string; detail: string }
    expect([refused.reason, refused.path, refused.detail]).toEqual([
      "invalid",
      undefined,
      "the manifest exceeds 65536 bytes"
    ])
  })

  it("refuses text that is not JSON", async () => {
    expect(await refusal(Manifest.parse("{"))).toMatchObject({ reason: "invalid", detail: "the manifest is not JSON" })
  })

  it("publishes the limits and the reserved namespaces", () => {
    expect([Manifest.maximumManifestBytes, Manifest.maximumEntriesPerPoint, Manifest.maximumSchemaBytes]).toEqual([
      65_536,
      64,
      16_384
    ])
    expect(Manifest.PLUGIN_API).toBe("1.0.0")
    expect(Manifest.RESERVED).toContain("core")
    expect(Object.isFrozen(Manifest.RESERVED)).toBe(true)
  })
})
