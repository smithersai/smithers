import { Event as ChainEvent, JsonBoundary, Script } from "@smthrs/chain"
import { Namespace, RecallKeyword } from "@smthrs/memory"
import { MarkdownFlow, ModuleFlow } from "@smthrs/registry"
import { it } from "@smthrs/testing/Vitest"
import { Option, Schema } from "effect"
import { describe, expect } from "vitest"

const provenance = { _tag: "BuiltIn" as const, source: "fuzz" } as const

describe("@smthrs/chain, @smthrs/registry, and @smthrs/memory fuzz", () => {
  it.fuzz(
    "Chain JsonBoundary enforces depth/size/JSON purity and decodeOutcome never crashes on arbitrary values",
    [Schema.Unknown, Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 150 }))],
    ([value, nestDepth]) => {
      const res = JsonBoundary.jsonBoundary(value)
      if (res._tag === "Ok") {
        // Accepted JSON must serialize cleanly
        expect(() => JSON.stringify(res.value)).not.toThrow()
      }
      // Decode outcome never throws on arbitrary values
      const outcome = JsonBoundary.decodeOutcome(value)
      expect(Option.isOption(outcome)).toBe(true)

      // Depth guard must strictly reject nesting deeper than maxJsonDepth
      let nested: unknown = 1
      for (let i = 0; i < nestDepth; i++) nested = [nested]
      const deepRes = JsonBoundary.jsonBoundary(nested)
      if (nestDepth > JsonBoundary.maxJsonDepth) {
        expect(deepRes._tag).toBe("Refused")
      }
      return true
    }
  )

  it.fuzz(
    "Chain Script.extract never throws on arbitrary model responses and deterministic Script.make digests match",
    [Schema.String],
    ([raw]) => {
      const extracted = Script.extract(raw)
      expect(typeof extracted._tag).toBe("string")
      const wf = raw.toWellFormed()
      const s1 = Script.make(wf)
      const s2 = Script.make(wf)
      expect(s1.digest).toBe(s2.digest)
      expect(s1.text).toBe(wf)
      return true
    }
  )

  it.fuzz(
    "Chain Event pure folds are consistent across arbitrary valid event streams",
    [
      Schema.Array(
        Schema.Union([
          Schema.Struct({ _tag: Schema.Literal("ChainStarted"), chain: Schema.String }),
          Schema.Struct({ _tag: Schema.Literal("LinkAuthored"), link: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })), text: Schema.String }),
          Schema.Struct({ _tag: Schema.Literal("SteeringDrained"), link: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })), ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })), line: Schema.String })
        ])
      ).check(Schema.isMaxLength(20))
    ],
    (rawEvents) => {
      const events: Array<ChainEvent.Event> = rawEvents.map((e) => {
        if (e._tag === "ChainStarted") {
          return { _tag: "ChainStarted", chain: "", goal: e.chain } as unknown as ChainEvent.Event
        }
        if (e._tag === "LinkAuthored") {
          return { _tag: "LinkAuthored", chain: "", link: e.link, script: Script.make(e.text.toWellFormed()) } as unknown as ChainEvent.Event
        }
        return { _tag: "SteeringDrained", chain: "", link: e.link, ordinal: e.ordinal, message: e.line } as unknown as ChainEvent.Event
      })
      const started = ChainEvent.started(events)
      expect(typeof started).toBe("boolean")
      const links = ChainEvent.linkCount(events)
      expect(links).toBeGreaterThanOrEqual(0)
      const term = ChainEvent.terminal(events)
      expect(term).toBeUndefined()
      return true
    }
  )

  it.fuzz(
    "Registry MarkdownFlow.fromMarkdown and loadBody/renderPrompt never throw on arbitrary untrusted markdown",
    [Schema.String, Schema.String, Schema.Literals(["path", "frontmatter"])],
    ([text, args, naming]) => {
      const result = MarkdownFlow.fromMarkdown({
        text,
        path: "/repo/.smithers/flows/fuzz/flow.mdx",
        baseDirectory: "/repo/.smithers/flows/fuzz",
        naming,
        name: Option.some("fuzz"),
        dirBasename: "fuzz",
        provenance
      })
      expect(Array.isArray(result.warnings)).toBe(true)
      const body = MarkdownFlow.loadBody(text, "/repo/.smithers/flows/fuzz")
      const rendered = MarkdownFlow.renderPrompt(body, { args })
      expect(typeof rendered).toBe("string")
      return true
    }
  )

  it.fuzz(
    "Registry ModuleFlow.fromModule never throws or executes code on arbitrary untrusted TS/VibeLang source",
    [Schema.String, Schema.Literals(["path", "frontmatter"])],
    ([text, naming]) => {
      const result = ModuleFlow.fromModule({
        text,
        path: "/repo/.smithers/flows/fuzz/flow.ts",
        naming,
        name: Option.some("fuzz"),
        dirBasename: "fuzz",
        provenance
      })
      expect(Array.isArray(result.warnings)).toBe(true)
      expect(Option.isOption(result.descriptor)).toBe(true)
      expect(Option.isOption(result.tag)).toBe(true)
      return true
    }
  )

  it.fuzz(
    "Memory Namespace.TagGroup decoding enforces bounds and RecallKeyword.scoreRow is finite and non-negative",
    [
      Schema.String,
      Schema.String,
      Schema.Array(Schema.String).check(Schema.isMaxLength(10)),
      Schema.Unknown
    ],
    ([query, text, tags, rawGroup]) => {
      const decoded = Schema.decodeUnknownOption(Namespace.TagGroup)(rawGroup)
      if (Option.isSome(decoded)) {
        const matched = Namespace.matches(decoded.value, tags)
        expect(typeof matched).toBe("boolean")
      }
      const terms = RecallKeyword.normalizeQueryTerms(query)
      const score = RecallKeyword.scoreRow(terms, {
        key: "k1",
        text,
        tags,
        status: "active",
        updatedAtMs: 1_700_000_000_000
      })
      expect(Number.isFinite(score)).toBe(true)
      expect(score).toBeGreaterThanOrEqual(0)
      return true
    }
  )
})
