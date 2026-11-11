import * as Flows from "@smthrs/memory/Flows"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as AuthorDeclaration from "../src/AuthorDeclaration.ts"
import * as Catalog from "../src/Catalog.ts"
import * as Event from "../src/Event.ts"
import * as MemoryEntries from "../src/MemoryEntries.ts"
import * as Script from "../src/Script.ts"
import * as SubChains from "../src/SubChains.ts"

// READ BEFORE CHANGING A VALUE HERE.
//
// Every literal below is a durable identity. `Catalog.entryDigest` decides
// whether a settled call may be replayed at all: `Chain.executeCall` refuses
// a journaled result whose recorded `entryDigest` differs from the one the
// catalog now carries, and `Script.make` keys every call a script issues. So
// a change to canonicalization, to the hash, to a digested field, or to an
// event's encoded shape turns every persisted chain into `replay_divergence`
// on resume.
//
// The rest of the suite recomputes both sides of every digest comparison
// with the same function, so it moves whenever the implementation moves.
// These do not. A red assertion here is a JOURNAL-FORMAT BREAK, not a test
// to update: either revert the change, or make it deliberately and record it
// in the changelog with a migration story for existing journals.

const entry: Catalog.Entry = {
  capabilities: ["fs:read:src/**"],
  description: "read one file from the workspace",
  handler: () => Effect.succeed(null),
  name: "repo/read"
}

const scriptDigest = "8b667690bac69a34fb75650ee74a634f39c4a177f0e94f6c3221fa97c84f4cae"
const entryDigest = "bed81f720eee70195780bf030e62b853a7a69c84609c4a45b09051e8d0e788cb"

describe("golden digests", () => {
  it("pins the author declaration digest", () => {
    expect(AuthorDeclaration.authorDigest).toBe(
      "e780ddd015104d0b8ac308797dcfb1edb5dc5bb914f953aa7f895cc9b1ee48c8"
    )
  })

  it("pins a script digest", () => {
    expect(Script.make("return done(null)").digest).toBe(scriptDigest)
  })

  it("pins a script digest over non-ASCII text", () => {
    expect(Script.make("return done(\"café ✓ 日本 🚀\")").digest).toBe(
      "612a70f60cd05b6fee33dbed6a0e6028ae705bf068b7859f8f32eba8f41e4a8c"
    )
  })

  it("pins a catalog entry digest with every digested field set", () => {
    expect(Catalog.entryDigest(entry)).toBe(entryDigest)
  })

  // An undeclared claim set claims `*`; an empty one claims nothing and
  // skips the `Authorize` seam. A journal settled under one must never
  // replay under the other.
  it("pins distinct digests for undeclared and empty capabilities", () => {
    const { capabilities: _, ...undeclared } = entry
    const undeclaredDigest = Catalog.entryDigest(undeclared)
    const emptyDigest = Catalog.entryDigest({ ...entry, capabilities: [] })
    expect(undeclaredDigest).toBe("cf87c45904f553acf49b2762577988f5a9def59da7365155fa01db446770c068")
    expect(emptyDigest).toBe("0a16b81f1c4f63ed7bd4013113218ffff3bd7101a2b855f5f378097815b06a9a")
    expect(undeclaredDigest).not.toBe(emptyDigest)
  })

  it("includes the child call budget in the sub-agent contract digest", () => {
    const digest = (maxCallsPerLink?: number) => SubChains.contractDigest({ entries: [], maxCallsPerLink })
    expect(new Set([digest(), digest(0), digest(1), digest(2)]).size).toBe(4)
  })

  it("pins the sub-agent contract digest at its defaults", () => {
    expect(SubChains.contractDigest({ entries: [] })).toBe(
      "12f6ce3f7a304b4a89d16bd5592e91ae5446b158484edf80722662465cddd7fb"
    )
  })

  it("pins the sub-agent contract digest with every option set", () => {
    expect(SubChains.contractDigest({ entries: [], maxCallsPerLink: 4, maxDepth: 2, maxLinks: 3, prefix: "child" }))
      .toBe("fe4fe814cc0c07765a45c9aabfbb967f8179d9184dcfab1a1bd124503874b1f0")
  })

  // The binding digests the memory door keys `remember` and `recall` by:
  // the shipped contract (schema identity, effects, name, description) under
  // a fixed policy.
  it("pins the remember and recall binding digests", async () => {
    const entries = await Effect.runPromise(
      MemoryEntries.make({ banks: ["worldview"], maxTokens: 1000 }).pipe(
        Effect.provide(Layer.merge(MemoryStore.layerNoop(), Recall.layerNoop))
      )
    )
    expect(entries.map((memory) => [memory.name, memory.digest])).toStrictEqual([
      [Flows.rememberName, "323fd8972d4cef3b3a5c5d95d802ab6dfec59a79704087ffe664e52aeb71ceee"],
      [Flows.recallName, "b6e006834066029ff26dd6903edd5d8f2de0ca23a63c3904ef5ad16a7d0578cf"]
    ])
  })
})

// The encoded form of the journal. A renamed field, a reordered union, or a
// schema swapped for one that encodes differently makes an existing journal
// undecodable — the same break as a moved digest, and just as invisible to a
// suite that only round-trips through the current schema.
describe("golden wire format", () => {
  const encode = Schema.encodeSync(Event.Event)

  const fixtures = [
    [
      "ChainStarted",
      { _tag: "ChainStarted", envelope: null, goal: "fix TODOs" },
      { _tag: "ChainStarted", envelope: null, goal: "fix TODOs" }
    ],
    [
      "CallSettled",
      {
        _tag: "CallSettled",
        key: { entryDigest, link: 1, ordinal: 0, scriptDigest },
        link: 1,
        name: "repo/read",
        payload: { path: "src/a.ts" },
        result: { body: "ok" }
      },
      {
        _tag: "CallSettled",
        key: { entryDigest, link: 1, ordinal: 0, scriptDigest },
        link: 1,
        name: "repo/read",
        payload: { path: "src/a.ts" },
        result: { body: "ok" }
      }
    ],
    [
      "LinkAuthored",
      { _tag: "LinkAuthored", link: 2, script: { digest: scriptDigest, text: "return done(null)" } },
      { _tag: "LinkAuthored", link: 2, script: { digest: scriptDigest, text: "return done(null)" } }
    ],
    [
      "GateRejected",
      {
        _tag: "GateRejected",
        link: 1,
        observation: { kind: "catalog", message: `"nope" is not a catalog entry` },
        ordinal: 3
      },
      {
        _tag: "GateRejected",
        link: 1,
        observation: { kind: "catalog", message: `"nope" is not a catalog entry` },
        ordinal: 3
      }
    ],
    [
      "SteeringDrained",
      { _tag: "SteeringDrained", link: 1, messages: ["stop after this"], ordinal: 2 },
      { _tag: "SteeringDrained", link: 1, messages: ["stop after this"], ordinal: 2 }
    ],
    [
      "LinkEnded",
      { _tag: "LinkEnded", link: 2, outcome: { _tag: "Park", reason: { code: "timer", message: "" } } },
      { _tag: "LinkEnded", link: 2, outcome: { _tag: "Park", reason: { code: "timer", message: "" } } }
    ],
    [
      "LinkEnded Done",
      { _tag: "LinkEnded", link: 3, outcome: { _tag: "Done", value: { fixed: 2 } } },
      { _tag: "LinkEnded", link: 3, outcome: { _tag: "Done", value: { fixed: 2 } } }
    ],
    [
      "LinkEnded To",
      {
        _tag: "LinkEnded",
        link: 1,
        outcome: { _tag: "To", script: { digest: scriptDigest, text: "return done(null)" } }
      },
      {
        _tag: "LinkEnded",
        link: 1,
        outcome: { _tag: "To", script: { digest: scriptDigest, text: "return done(null)" } }
      }
    ]
  ] as const

  describe.each(
    [
      ["absent", {}, {}],
      ["empty", { chain: "" }, { chain: "" }],
      ["child", { chain: "root-a/1.0" }, { chain: "root-a/1.0" }]
    ] as const
  )("%s chain scope", (_scope, decodedScope, wireScope) => {
    it.each(fixtures)("encodes %s to its pinned shape", (_tag, event, wire) => {
      expect(encode({ ...event, ...decodedScope } as Event.Event)).toStrictEqual({ ...wire, ...wireScope })
    })

    it.each(fixtures)("decodes the complete pinned %s shape", (_tag, event, wire) => {
      const decode = Schema.decodeUnknownSync(Event.Event)
      expect(decode({ ...wire, ...wireScope })).toStrictEqual({ ...event, ...decodedScope })
    })
  })
})
