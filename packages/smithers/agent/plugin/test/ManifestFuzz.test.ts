import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Reason, Refusal } from "../src/Contribution.ts"
import * as Load from "../src/Load.ts"
import * as Manifest from "../src/Manifest.ts"
import { host, minimal, owned, queueManifest } from "./support/hostFacts.ts"

/** mulberry32: a small seeded generator, so every run tries the same inputs. */
const generator = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

type Random = () => number

const pick = <A>(random: Random, values: ReadonlyArray<A>): A => values[Math.floor(random() * values.length)]!

const words = [
  "id",
  "queue",
  "$ref",
  "#/$defs/Note",
  "$item.runId",
  "$event.note",
  "view == queue/queue",
  "g q",
  "",
  "__proto__",
  "constructor",
  "run/answer",
  "core/waits",
  "component",
  "1.0.0",
  "^1.0.0",
  "é",
  "x".repeat(100)
]

const json = (random: Random, depth: number): unknown => {
  const roll = random()
  if (depth <= 0 || roll < 0.35) {
    return pick(random, [null, true, false, 0, -1, 1.5, 2 ** 53, pick(random, words), Math.floor(random() * 10)])
  }
  if (roll < 0.65) return Array.from({ length: Math.floor(random() * 4) }, () => json(random, depth - 1))
  return Object.fromEntries(
    Array.from({ length: Math.floor(random() * 4) }, () => [pick(random, words), json(random, depth - 1)])
  )
}

/** Replaces or deletes one value somewhere in a manifest. */
const mutate = (random: Random, value: any, depth = 0): unknown => {
  if (typeof value !== "object" || value === null || depth > 6) return json(random, 3)
  const keys = Object.keys(value)
  if (keys.length === 0 || random() < 0.15) return json(random, 3)
  const key = pick(random, keys)
  const copy = Array.isArray(value) ? [...value] : { ...value }
  if (random() < 0.2 && !Array.isArray(copy)) delete (copy as Record<string, unknown>)[key]
  else (copy as any)[key] = mutate(random, (value as any)[key], depth + 1)
  return copy
}

/** Keeps manifest shapes valid while varying the loader's contribution checks. */
const mutateContribution = (random: Random): unknown => {
  const manifest = queueManifest()
  const { commands, keybindings, slots, views } = manifest.contributes
  const view = views[0]
  const event = pick<any>(random, view.events.filter((entry: any) => "flow" in entry))
  // Portable renderers let repository and personal plugins reach the same checks.
  if (random() < 0.5) {
    view.render = { kind: "blocks", blocks: [] }
    slots[0].render = { kind: "blocks", blocks: [] }
  }
  switch (Math.floor(random() * 12)) {
    case 0:
      view.id = pick(random, ["queue/queue", "queue/detail", "other/view", "core/view"])
      break
    case 1:
      event.flow = pick(random, ["run/answer", "app/navigate", "missing/flow"])
      break
    case 2:
      event.args.runId = pick(random, ["$item.runId", "$item.missing", "$event.note", "$key.index", "literal", 0])
      break
    case 3:
      event.payload = { $ref: pick(random, ["#/$defs/Option", "#/$defs/Note", "#/$defs/Missing"]) }
      break
    case 4:
      keybindings[1].when = pick(random, ["", "view == queue/queue", "view == queue/detail", "item.question &&"])
      break
    case 5:
      keybindings[1].fields.index = pick(random, ["$key.index", "$event.index", "$item.version", 0, 8, 9])
      break
    case 6:
      keybindings[1].key = pick(random, ["digit", "g q", "mod+enter", "unknown+key"])
      break
    case 7:
      commands[0].flow = pick(random, ["app/navigate", "run/answer", "missing/flow"])
      break
    case 8:
      commands[0].args.to = pick(random, ["/app/queue", "$item.runId", 0, null])
      break
    case 9:
      view.minimum = pick(random, ["anyone", "guest", "member", "maintainer", "admin"])
      break
    case 10:
      event.name = pick(random, ["option", "reply", "next", "custom"])
      break
    case 11:
      slots[0].when = pick(random, ["", "view == queue/queue", "item.question &&"])
      break
  }
  return manifest
}

/** Decoding either succeeds or fails with a Refusal: it never throws or dies. */
const settles = (input: unknown) => {
  const exit = Effect.runSync(Effect.exit(Manifest.decode(input)))
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause), JSON.stringify(input)?.slice(0, 200)).toBe(false)
    expect(Cause.squash(exit.cause)).toBeInstanceOf(Refusal)
  }
  return Exit.isSuccess(exit)
}

describe("fuzzed decoding", () => {
  it("random JSON only decodes or refuses", () => {
    const random = generator(17)
    for (let run = 0; run < 2_000; run++) settles(json(random, 5))
  })

  it.each(["built-in", "repository", "personal"] as const)(
    "mutated queue manifests reach loader admission at the %s tier without failing",
    async (tier) => {
      const random = generator(2026)
      let decoded = 0
      let active = 0
      let admissionRefusals = 0
      const refusedPoints = new Set<string>()
      for (let run = 0; run < 1_500; run++) {
        const manifest = run % 2 === 0 ? mutateContribution(random) : mutate(random, queueManifest())
        if (!settles(manifest)) continue
        decoded++
        // Loading one candidate prevents duplicate ids from bypassing admission.
        const { contributions, refused } = await Effect.runPromise(Load.load(host(), [{ tier, manifest }]))
        expect(contributions.plugins.length + refused.length).toBe(1)
        if (contributions.plugins.length === 1) {
          expect(refused).toEqual([])
          expect(contributions.plugins[0]).toMatchObject({ tier })
          active++
        } else {
          expect(refused).toHaveLength(1)
          expect(refused[0]).toBeInstanceOf(Refusal)
          expect(Schema.is(Reason)(refused[0]!.reason)).toBe(true)
          if (refused[0]!.path?.startsWith("contributes.")) {
            admissionRefusals++
            refusedPoints.add(refused[0]!.path.split(/[.\[]/)[1]!)
          }
        }
      }
      expect(decoded).toBeGreaterThan(600)
      expect(active).toBeGreaterThan(30)
      expect(admissionRefusals).toBeGreaterThan(100)
      expect([...refusedPoints].sort()).toEqual(["commands", "keybindings", "slots", "views"])
    }
  )

  it("random text only parses or refuses", () => {
    const random = generator(99)
    for (let run = 0; run < 500; run++) {
      const text = JSON.stringify(json(random, 4)) ?? ""
      const cut = text.slice(0, Math.floor(random() * (text.length + 1)))
      const exit = Effect.runSync(Effect.exit(Manifest.parse(cut)))
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(false)
    }
  })
})

describe("manifest diagnostic and dependency mutations", () => {
  it("never echoes arbitrary keys from argument or schema mutations", async () => {
    const random = generator(0x4872)
    for (let index = 0; index < 96; index++) {
      const key = pick(random, ["password ", "<img>\n", "\u202e", "x".repeat(65), "a.b "]) + index
      const manifest = queueManifest()
      if (random() < 0.5) manifest.contributes.views[0].events[0].args[key] = "$item.missing"
      else manifest.$defs.Note.properties[key] = { type: "string", writeOnly: true }
      const loaded = await Effect.runPromise(Load.load(host(), [{ tier: "built-in", manifest }]))
      expect(loaded.refused).toHaveLength(1)
      expect(JSON.stringify(loaded.refused)).not.toContain(key)
      expect(loaded.refused[0]!.path).toContain("[key:")
    }
  })

  it("admits cross-plugin uses exactly when the owner is a declared dependency", async () => {
    const random = generator(0x487208)
    for (let index = 0; index < 96; index++) {
      const owner = pick(random, ["aa", "zz"]) + index
      const consumer = pick(random, ["bb", "yy"]) + index
      const declared = random() < 0.5
      const candidates: Array<Load.Candidate> = [
        { tier: "built-in", manifest: minimal(owner), flows: [owned(owner + "/act")] },
        {
          tier: pick(random, ["built-in", "repository", "personal"] as const),
          manifest: minimal(consumer, {
            uses: [owner + "/act"],
            requires: { api: "*", ...(declared ? { plugins: { [owner]: "*" } } : {}) }
          })
        }
      ]
      if (random() < 0.5) candidates.reverse()
      const loaded = await Effect.runPromise(Load.load(host({ points: ["flows"] }), candidates))
      expect(loaded.contributions.plugins.map(({ id }) => id)).toEqual(declared ? [owner, consumer] : [owner])
      expect(loaded.refused.map(({ plugin, reason, path }) => [plugin, reason, path]))
        .toEqual(declared ? [] : [[consumer, "missing_dependency", "uses[0]"]])
    }
  })
})
