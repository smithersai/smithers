import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as Request from "@smthrs/model/ModelRequest"
import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as Tokens from "../src/Tokens.ts"

const system = Request.SystemPart.make({ text: "Be concise." })
const tool = Request.ToolDefinition.make({ name: "read", description: "Read", parameters: {} })
const lazyTool = Request.ToolDefinition.make({
  name: "write",
  description: "Write",
  parameters: {},
  deferred: true
})

/** The window with a lazily loaded tool declared but not yet activated. */
const lazy = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "tools", zone: "prefix", content: [tool, lazyTool] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("load a tool")] }
    ],
    activeTools: []
  })

/** The identity a provider caches: the digests of the prefix-zone segments. */
const sealedPrefix = (value: ContextWindow.ContextWindow) =>
  value.segments.filter((segment) => segment.zone === "prefix").map((segment) => segment.digest)

const base = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "instructions", zone: "prefix", content: [Request.SystemPart.make({ text: "Follow instructions" })] },
      { kind: "tools", zone: "prefix", content: [tool] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("first")] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("second")] }
    ],
    activeTools: ["read"]
  })

/** A window whose only compactable content is one transcript segment. */
const single = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("only")] }
    ]
  })

/** A window with nothing compaction is allowed to replace. */
const sealedOnly = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "tools", zone: "prefix", content: [tool] }
    ],
    activeTools: ["read"]
  })

const texts = (request: Request.ModelRequest) =>
  request.messages.map((message) => message.content.find((part) => "text" in part)?.text)

describe("ContextWindow", () => {
  it("has a deterministic digest and never mutates its input", () => {
    const first = base()
    const second = base()
    const next = ContextWindow.appendTurn(first, Request.Message.assistant("working"), [])
    expect(first.digest).toBe(second.digest)
    expect(next.digest).not.toBe(first.digest)
    expect(first.segments).toHaveLength(5)
  })

  it("copies caller-owned arrays so later input mutation cannot invalidate its digest", () => {
    const content = [Request.Message.user("first")]
    const segments: Array<ContextWindow.SegmentInput> = [{ kind: "transcript", zone: "tail", content }]
    const activeTools = ["read"]
    const value = ContextWindow.make({ modelId: "test-model", segments, activeTools })
    const before = ContextWindow.render(value)
    const digest = value.digest

    content.push(Request.Message.user("injected"))
    segments.push({ kind: "transcript", zone: "tail", content: [Request.Message.user("also injected")] })
    activeTools.push("write")

    expect(ContextWindow.render(value)).toEqual(before)
    expect(value.digest).toBe(digest)
    expect(value.activeTools).toEqual(["read"])
  })

  it("freezes every array exposed by a context window", () => {
    const value = base()

    expect(() => (value.segments as Array<ContextWindow.Segment>).push(value.segments[0]!)).toThrow(TypeError)
    expect(() => (value.activeTools as Array<string>).push("write")).toThrow(TypeError)
    expect(() => (value.segments[0]!.content as Array<typeof system>).push(system)).toThrow(TypeError)
  })

  it("freezes the segments, messages and parts behind those arrays", () => {
    // The digest is taken once, at construction, and it is what the sealed step
    // is keyed on. Freezing only the outer arrays left every value inside them
    // editable in place, so a window could render content its own identity no
    // longer described.
    const message = Request.Message.user("first")
    const declaration = Request.ToolDefinition.make({
      name: "read",
      description: "Read",
      // A JSON `null` inside the declaration, because the walk has to reach
      // one: it is the value a naive `typeof value === "object"` test freezes
      // by calling `Object.values` on it.
      parameters: { type: "object", properties: null }
    })
    const value = ContextWindow.make({
      modelId: "test-model",
      segments: [
        { kind: "tools", zone: "prefix", content: [declaration] },
        { kind: "transcript", zone: "tail", content: [message] }
      ]
    })
    const rendered = ContextWindow.render(value)
    const digest = value.digest
    const segment = value.segments[1]!
    const projected = segment.content[0] as Request.UserMessage

    expect(() => ((segment as { digest: string }).digest = "forged")).toThrow(TypeError)
    expect(() => ((projected as { role: string }).role = "assistant")).toThrow(TypeError)
    expect(() => ((projected.content as Array<never>).length = 0)).toThrow(TypeError)
    expect(() => ((projected.content[0] as { text: string }).text = "rewritten")).toThrow(TypeError)
    expect(() => {
      ;(value.segments[0]!.content[0] as { name: string }).name = "write"
    }).toThrow(TypeError)

    // The value handed in is the value frozen: a caller holding its own
    // reference to a message cannot edit the copy the window rendered.
    expect(Object.isFrozen(message)).toBe(true)
    expect(ContextWindow.render(value)).toEqual(rendered)
    expect(value.digest).toBe(digest)
  })

  it("freezes what a caller froze only shallowly", () => {
    // A caller's frozen array says nothing about the message and part below it.
    // Treating that outer marker as a completed walk left both mutable, so the
    // rendered request could move while its construction-time digest stood still.
    const message = Request.Message.user("before")
    const content = Object.freeze([message])
    const segment = new ContextWindow.Segment({
      kind: "transcript",
      zone: "tail",
      digest: "caller-derived",
      tokens: Tokens.count("before"),
      content
    })
    const value = ContextWindow.make({
      modelId: "test-model",
      segments: [segment]
    })
    const rendered = ContextWindow.render(value)
    const digest = value.digest
    const projected = value.segments[0]!.content[0] as Request.UserMessage

    expect(() => ((projected.content[0] as { text: string }).text = "after")).toThrow(TypeError)
    expect(ContextWindow.render(value)).toEqual(rendered)
    expect(value.digest).toBe(digest)
  })

  it("never executes an accessor while freezing", () => {
    // `Object.values` invoked enumerable accessors while looking for children.
    // Freezing is structural work, so a getter could otherwise make an ordinary
    // window construction run caller code and throw for reasons outside it.
    let reads = 0
    const trapped = {}
    Object.defineProperty(trapped, "trap", {
      enumerable: true,
      get() {
        reads += 1
        throw new Error("read")
      }
    })
    const message = Request.Message.user("safe")
    Object.defineProperty(message.content, "trapped", { enumerable: true, value: trapped })

    const value = ContextWindow.make({
      modelId: "test-model",
      segments: [{ kind: "transcript", zone: "tail", content: [message] }]
    })

    expect(value.segments).toHaveLength(1)
    expect(reads).toBe(0)
  })

  it("uses the canonical keys SHA-256 digest for window identity", () => {
    const value = base()
    expect(value.digest).toBe(
      Digest.digest(CanonicalJson.stringify({
        modelId: value.modelId,
        segments: value.segments.map((segment) => segment.digest),
        activeTools: value.activeTools
      }))
    )
  })

  it("activates tools additively without changing the stable prefix", () => {
    const value = lazy()
    const first = ContextWindow.activateTools(value, ["read", "read"])
    const second = ContextWindow.activateTools(first, ["write"])

    // Each activation adds, and adds only what the window did not already hold.
    expect(value.activeTools).toEqual([])
    expect(first.activeTools).toEqual(["read"])
    expect(second.activeTools).toEqual(["read", "write"])
    expect(first).not.toBe(value)
    expect(first.digest).not.toBe(value.digest)

    // Activation never rewrites a sealed segment, so the cached prefix survives.
    expect(sealedPrefix(second)).toEqual(sealedPrefix(value))
    expect(second.tokens.prefix).toEqual(value.tokens.prefix)

    // A redundant activation keeps the object, and with it the window digest.
    expect(ContextWindow.activateTools(second, ["read"])).toBe(second)
    expect(ContextWindow.activateTools(second, [" WRITE "])).toBe(second)
  })

  it("renders the same prefix when a lazily loaded tool activates", () => {
    const value = lazy()
    const activated = ContextWindow.activateTools(value, ["write"])
    const before = ContextWindow.render(value)
    const after = ContextWindow.render(activated)

    // A deferred declaration is advertised before and after activation, so the
    // prefix the provider caches is unchanged by loading the tool.
    expect(after.tools.map((definition) => definition.name)).toEqual(["write"])
    expect(after.modelId).toBe(before.modelId)
    expect(after.system).toEqual(before.system)
    expect(after.messages).toEqual(before.messages)
    expect(after.tools).toEqual(before.tools)
  })

  it("appends a tool message carrying the ordered results after the assistant turn", () => {
    const assistant = Request.Message.assistant(
      Request.ToolCallPart.make({ id: "call-1", name: "read", arguments: "{\"path\":\"a\"}" }),
      { stopReason: "tool-calls" }
    )
    const result = Request.ToolResultPart.make({ toolCallId: "call-1", content: "file contents" })
    const next = ContextWindow.appendTurn(base(), assistant, [result])

    const appended = next.segments[next.segments.length - 1]
    expect(appended?.kind).toBe("transcript")
    expect(appended?.zone).toBe("tail")
    expect(appended?.content).toEqual([assistant, Request.Message.tool([result])])

    const request = ContextWindow.render(next)
    expect(request.messages.slice(-2).map((message) => message.role)).toEqual(["assistant", "tool"])
    expect(request.messages[request.messages.length - 1]?.content).toEqual([result])
  })

  it("keeps token accounting aligned with segments", () => {
    const value = base()
    const sum = value.tokens.bySegment.reduce((total, segment) => total + segment.tokens.value, 0)
    expect(value.tokens.total.value).toBe(sum)
    expect(value.tokens.total.estimated).toBe(true)
  })

  it("compacts the transcript prefix and renders a valid request", () => {
    const compacted = Result.getOrThrow(ContextWindow.compact(base(), Request.Message.user("summary")))
    const request = ContextWindow.render(compacted)
    expect(compacted.replaced).toBeDefined()
    expect(request.messages.map((message) => message.content.find((part) => "text" in part)?.text)).toEqual([
      "summary",
      "second"
    ])
    expect(request.tools.map((definition) => definition.name)).toEqual(["read"])
  })

  it("returns a stable typed error for an invalid compaction prefix", () => {
    const result = ContextWindow.prefixDigest(base(), -1)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        code: "invalid_compaction_prefix"
      })
    }
  })

  describe("construction boundaries", () => {
    it("builds an empty window with no segments, no tools, and a zero accounting", () => {
      const value = ContextWindow.empty("test-model")
      expect(value.modelId).toBe("test-model")
      expect(value.segments).toEqual([])
      expect(value.activeTools).toEqual([])
      expect(value.replaced).toBeUndefined()
      expect(value.tokens.total.value).toBe(0)
      expect(value.tokens.prefix.value).toBe(0)
      expect(value.tokens.tail.value).toBe(0)
      // Nothing was estimated, because nothing was counted.
      expect(value.tokens.total.estimated).toBe(false)
    })

    it("treats omitted segments and tools the same as empty ones", () => {
      expect(ContextWindow.make({ modelId: "test-model" }).digest).toBe(
        ContextWindow.make({ modelId: "test-model", segments: [], activeTools: [] }).digest
      )
      expect(ContextWindow.empty("test-model").digest).toBe(ContextWindow.make({ modelId: "test-model" }).digest)
    })

    it("separates windows that differ only by model id", () => {
      expect(ContextWindow.empty("a").digest).not.toBe(ContextWindow.empty("b").digest)
    })

    it("folds a declared replacement digest into window identity", () => {
      const plain = ContextWindow.make({ modelId: "test-model" })
      const replaced = ContextWindow.make({ modelId: "test-model", replaced: "prior" })
      expect(replaced.replaced).toBe("prior")
      expect(replaced.digest).not.toBe(plain.digest)
    })

    it("keeps an already-built segment, digest and all", () => {
      const built = ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content: [] })
      expect(ContextWindow.makeSegment(built)).toBe(built)
      expect(ContextWindow.make({ modelId: "test-model", segments: [built] }).segments[0]?.digest).toBe(built.digest)
    })

    it("counts a segment with empty content without failing", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [{ kind: "transcript", zone: "tail", content: [] }]
      })
      expect(value.segments[0]?.content).toEqual([])
      expect(value.tokens.total.value).toBeGreaterThanOrEqual(0)
      expect(ContextWindow.render(value).messages).toEqual([])
    })

    it("uses a supplied token count instead of estimating one", () => {
      const declared = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [Request.Message.user("a much longer body than seven tokens")],
        tokens: { value: 7, estimated: false }
      })
      expect(declared.tokens).toEqual({ value: 7, estimated: false })
      const estimated = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [Request.Message.user("a much longer body than seven tokens")]
      })
      expect(estimated.tokens.estimated).toBe(true)
      // The declared count is not part of segment identity.
      expect(declared.digest).toBe(estimated.digest)
    })

    it("folds a declared digest into segment identity", () => {
      const content = [Request.Message.user("same")]
      const plain = ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content })
      const declared = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content,
        declaredDigest: "upstream"
      })
      expect(declared.digest).not.toBe(plain.digest)
      expect(
        ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content, declaredDigest: undefined }).digest
      ).toBe(plain.digest)
    })

    it("separates segments that differ only by kind or zone", () => {
      const content = [Request.Message.user("same")]
      const digests = new Set([
        ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content }).digest,
        ContextWindow.makeSegment({ kind: "summary", zone: "tail", content }).digest,
        ContextWindow.makeSegment({ kind: "transcript", zone: "prefix", content }).digest
      ])
      expect(digests.size).toBe(3)
    })

    it("digests an explicitly undefined field the same as an absent one", () => {
      const explicit = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [Request.Message.assistant(Request.ThinkingPart.make({ text: "t" }), { stopReason: "stop" })]
      })
      const absent = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [Request.Message.assistant([{ type: "thinking", text: "t" }], { stopReason: "stop" })]
      })
      expect(explicit.digest).toBe(absent.digest)
    })

    it("digests a null inside a tool parameter document as null", () => {
      const nullable = Request.ToolDefinition.make({
        name: "nullable",
        description: "Nullable",
        parameters: { fallback: null }
      })
      const missing = Request.ToolDefinition.make({ name: "nullable", description: "Nullable", parameters: {} })
      const digestOf = (definition: Request.ToolDefinition) =>
        ContextWindow.makeSegment({ kind: "tools", zone: "prefix", content: [definition] }).digest
      expect(digestOf(nullable)).not.toBe(digestOf(missing))
    })

    it("drops blank and duplicate tool names when normalizing the active set", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        activeTools: ["read", "", "   ", "READ", " read ", "write"]
      })
      expect(value.activeTools).toEqual(["read", "write"])
    })

    it("keeps the first spelling of a tool name that repeats in another case", () => {
      expect(ContextWindow.make({ modelId: "test-model", activeTools: [" Read ", "read"] }).activeTools).toEqual([
        " Read "
      ])
    })

    it("splits the accounting by cache zone", () => {
      const value = base()
      const zone = (name: "prefix" | "tail") =>
        value.segments.filter((segment) => segment.zone === name).reduce(
          (total, segment) => total + segment.tokens.value,
          0
        )
      expect(value.tokens.prefix.value).toBe(zone("prefix"))
      expect(value.tokens.tail.value).toBe(zone("tail"))
      expect(value.tokens.bySegment.map((segment) => segment.digest)).toEqual(
        value.segments.map((segment) => segment.digest)
      )
    })
  })

  describe("the class surface", () => {
    it("delegates every static to the standalone combinator", () => {
      const value = ContextWindow.ContextWindow.make({
        modelId: "test-model",
        segments: [{ kind: "transcript", zone: "tail", content: [Request.Message.user("first")] }]
      })
      expect(value.digest).toBe(
        ContextWindow.make({
          modelId: "test-model",
          segments: [{ kind: "transcript", zone: "tail", content: [Request.Message.user("first")] }]
        }).digest
      )
      expect(ContextWindow.ContextWindow.empty("test-model").digest).toBe(ContextWindow.empty("test-model").digest)

      const assistant = Request.Message.assistant("working", { stopReason: "stop" })
      expect(ContextWindow.ContextWindow.appendTurn(value, assistant, []).digest).toBe(
        ContextWindow.appendTurn(value, assistant, []).digest
      )
      expect(ContextWindow.ContextWindow.activateTools(value, ["read"]).activeTools).toEqual(["read"])
      expect(ContextWindow.ContextWindow.render(value)).toEqual(ContextWindow.render(value))

      const summary = Request.Message.user("summary")
      expect(Result.getOrThrow(ContextWindow.ContextWindow.compact(value, summary)).digest).toBe(
        Result.getOrThrow(ContextWindow.compact(value, summary)).digest
      )
    })

    it("returns itself from an empty pipe", () => {
      const value = base()
      // `pipe` is declared with no parameters and an `unknown` result, so the
      // empty pipe is the only form the type checker accepts on this class.
      expect(value.pipe()).toBe(value)
    })

    it("reaches the same window through the data-last form of every combinator", () => {
      const value = base()
      const assistant = Request.Message.assistant("working", { stopReason: "stop" })
      const result = Request.ToolResultPart.make({ toolCallId: "call-1", content: "ok" })
      expect(ContextWindow.appendTurn(assistant, [result])(value).digest).toBe(
        ContextWindow.appendTurn(value, assistant, [result]).digest
      )
      expect(ContextWindow.activateTools(["write"])(value).activeTools).toEqual(["read", "write"])

      const summary = Request.Message.user("summary")
      expect(Result.getOrThrow(ContextWindow.compact(summary)(value)).digest).toBe(
        Result.getOrThrow(ContextWindow.compact(value, summary)).digest
      )
    })
  })

  describe("appendTurn", () => {
    it("appends only the assistant message when the turn called no tools", () => {
      const assistant = Request.Message.assistant("done", { stopReason: "stop" })
      const next = ContextWindow.appendTurn(base(), assistant, [])
      expect(next.segments.at(-1)?.content).toEqual([assistant])
    })

    it("appends one tool message holding every result in the order supplied", () => {
      const assistant = Request.Message.assistant(
        [
          Request.ToolCallPart.make({ id: "a", name: "read", arguments: "{}" }),
          Request.ToolCallPart.make({ id: "b", name: "read", arguments: "{}" })
        ],
        { stopReason: "tool-calls" }
      )
      const results = [
        Request.ToolResultPart.make({ toolCallId: "b", content: "second" }),
        Request.ToolResultPart.make({ toolCallId: "a", content: "first" })
      ]
      const next = ContextWindow.appendTurn(base(), assistant, results)
      expect(next.segments.at(-1)?.content).toEqual([assistant, Request.Message.tool(results)])
      expect(next.segments).toHaveLength(base().segments.length + 1)
    })

    it("carries the active tools and the replacement digest onto the new window", () => {
      const compacted = Result.getOrThrow(ContextWindow.compact(base(), Request.Message.user("summary")))
      const next = ContextWindow.appendTurn(compacted, Request.Message.assistant("more"), [])
      expect(next.replaced).toBe(compacted.replaced)
      expect(next.activeTools).toEqual(compacted.activeTools)
    })

    it("appends onto an empty window", () => {
      const assistant = Request.Message.assistant("first words")
      const next = ContextWindow.appendTurn(ContextWindow.empty("test-model"), assistant, [])
      expect(next.segments).toHaveLength(1)
      expect(ContextWindow.render(next).messages).toEqual([assistant])
    })
  })

  describe("activateTools", () => {
    it("returns the same window for an empty activation list", () => {
      const value = base()
      expect(ContextWindow.activateTools(value, [])).toBe(value)
    })

    it("returns the same window when every name is blank", () => {
      const value = base()
      expect(ContextWindow.activateTools(value, ["", "  "])).toBe(value)
    })

    it("activates a tool the window never declared", () => {
      const value = ContextWindow.activateTools(base(), ["never-declared"])
      expect(value.activeTools).toEqual(["read", "never-declared"])
      // An activation without a declaration adds nothing to the request.
      expect(ContextWindow.render(value).tools.map((definition) => definition.name)).toEqual(["read"])
    })

    it("keeps every segment digest when activating", () => {
      const value = lazy()
      const activated = ContextWindow.activateTools(value, ["write"])
      expect(activated.segments.map((segment) => segment.digest)).toEqual(
        value.segments.map((segment) => segment.digest)
      )
      expect(activated.digest).not.toBe(value.digest)
    })

    it("carries the replacement digest through an activation", () => {
      const compacted = Result.getOrThrow(ContextWindow.compact(lazy(), Request.Message.user("summary")))
      expect(ContextWindow.activateTools(compacted, ["write"]).replaced).toBe(compacted.replaced)
    })
  })

  describe("prefixDigest", () => {
    it("digests the empty prefix of any window identically", () => {
      const expected = Digest.digest(CanonicalJson.stringify([]))
      expect(Result.getOrThrow(ContextWindow.prefixDigest(base(), 0))).toBe(expected)
      expect(Result.getOrThrow(ContextWindow.prefixDigest(ContextWindow.empty("test-model"), 0))).toBe(expected)
    })

    it("digests the whole compactable set at its exact length", () => {
      expect(Result.isSuccess(ContextWindow.prefixDigest(base(), 2))).toBe(true)
    })

    it("fails one segment past the compactable set", () => {
      const result = ContextWindow.prefixDigest(base(), 3)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe("invalid_compaction_prefix")
        expect(result.failure.message).toBe("Compaction prefix length exceeds the compactable context")
      }
    })

    it("counts only compactable segments toward the prefix length", () => {
      // `base()` holds five segments but only two the prefix may reach.
      expect(Result.isFailure(ContextWindow.prefixDigest(base(), 5))).toBe(true)
      expect(Result.isFailure(ContextWindow.prefixDigest(sealedOnly(), 1))).toBe(true)
    })

    it("rejects a prefix length that is not a non-negative safe integer", () => {
      for (const length of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        const result = ContextWindow.prefixDigest(base(), length)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure.message).toBe("Compaction prefix length must be a non-negative safe integer")
        }
      }
    })

    it("changes when the prefix content changes and not when the suffix does", () => {
      const value = base()
      const appended = ContextWindow.appendTurn(value, Request.Message.assistant("later"), [])
      expect(Result.getOrThrow(ContextWindow.prefixDigest(appended, 1))).toBe(
        Result.getOrThrow(ContextWindow.prefixDigest(value, 1))
      )
      expect(Result.getOrThrow(ContextWindow.prefixDigest(value, 2))).not.toBe(
        Result.getOrThrow(ContextWindow.prefixDigest(value, 1))
      )
    })
  })

  describe("compactPrefix", () => {
    it("returns the identical window for a zero-length prefix", () => {
      const value = base()
      expect(Result.getOrThrow(ContextWindow.compactPrefix(value, 0, Request.Message.user("summary")))).toBe(value)
    })

    it("returns the identical window when nothing is compactable", () => {
      const value = sealedOnly()
      expect(Result.getOrThrow(ContextWindow.compactPrefix(value, 0, Request.Message.user("summary")))).toBe(value)
    })

    it("fails past the compactable set instead of compacting what it can", () => {
      expect(Result.isFailure(ContextWindow.compactPrefix(base(), 3, Request.Message.user("s")))).toBe(true)
    })

    it("inserts the summary where the first replaced segment sat, keeping sealed segments in place", () => {
      const compacted = Result.getOrThrow(ContextWindow.compactPrefix(base(), 1, Request.Message.user("summary")))
      expect(compacted.segments.map((segment) => segment.kind)).toEqual([
        "system",
        "instructions",
        "tools",
        "summary",
        "transcript"
      ])
      expect(compacted.segments.find((segment) => segment.kind === "summary")?.zone).toBe("tail")
      expect(texts(ContextWindow.render(compacted))).toEqual(["summary", "second"])
    })

    it("replaces the whole compactable set when the prefix covers it", () => {
      const compacted = Result.getOrThrow(ContextWindow.compactPrefix(base(), 2, Request.Message.user("all of it")))
      expect(compacted.segments.filter((segment) => segment.kind === "transcript")).toEqual([])
      expect(texts(ContextWindow.render(compacted))).toEqual(["all of it"])
    })

    it("accepts a list of summary messages", () => {
      const compacted = Result.getOrThrow(
        ContextWindow.compactPrefix(base(), 2, [Request.Message.user("part one"), Request.Message.user("part two")])
      )
      expect(texts(ContextWindow.render(compacted))).toEqual(["part one", "part two"])
    })

    it("accepts an empty list of summary messages, dropping the prefix outright", () => {
      const compacted = Result.getOrThrow(ContextWindow.compactPrefix(base(), 2, []))
      expect(compacted.segments.map((segment) => segment.kind)).toEqual([
        "system",
        "instructions",
        "tools",
        "summary"
      ])
      expect(ContextWindow.render(compacted).messages).toEqual([])
    })

    it("records the digest of exactly what it replaced", () => {
      const value = base()
      const compacted = Result.getOrThrow(ContextWindow.compactPrefix(value, 1, Request.Message.user("summary")))
      expect(compacted.replaced).toBe(Result.getOrThrow(ContextWindow.prefixDigest(value, 1)))
    })

    it("grows the accounting when the summary is larger than what it replaced", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [{
          kind: "transcript",
          zone: "tail",
          content: [Request.Message.user("hi")],
          tokens: { value: 1, estimated: false }
        }]
      })
      const compacted = Result.getOrThrow(
        ContextWindow.compactPrefix(value, 1, Request.Message.user("verbose ".repeat(200)))
      )
      expect(compacted.tokens.total.value).toBeGreaterThan(value.tokens.total.value)
    })

    it("compacts a window that is already a summary plus a tail", () => {
      const once = Result.getOrThrow(
        ContextWindow.compactPrefix(base(), 1, Request.Message.assistant("first summary", { stopReason: "stop" }))
      )
      expect(ContextWindow.render(once).messages[0]?.role).toBe("user")

      const twice = Result.getOrThrow(
        ContextWindow.compactPrefix(once, 2, Request.Message.assistant("second summary", { stopReason: "stop" }))
      )
      expect(twice.segments.filter((segment) => segment.kind === "summary")).toHaveLength(1)
      expect(texts(ContextWindow.render(twice))).toEqual(["second summary"])
      expect(ContextWindow.render(twice).messages[0]?.role).toBe("user")
      expect(twice.replaced).not.toBe(once.replaced)
    })
  })

  describe("compact", () => {
    it("retains the last compactable segment when more than one exists", () => {
      const compacted = Result.getOrThrow(ContextWindow.compact(base(), Request.Message.user("summary")))
      expect(texts(ContextWindow.render(compacted))).toEqual(["summary", "second"])
    })

    it("replaces the only compactable segment when just one exists", () => {
      const compacted = Result.getOrThrow(ContextWindow.compact(single(), Request.Message.user("summary")))
      expect(compacted.segments.map((segment) => segment.kind)).toEqual(["system", "summary"])
      expect(texts(ContextWindow.render(compacted))).toEqual(["summary"])
      expect(compacted.replaced).toBeDefined()
    })

    it("returns the identical window when there is nothing compactable", () => {
      const value = sealedOnly()
      expect(Result.getOrThrow(ContextWindow.compact(value, Request.Message.user("summary")))).toBe(value)
      expect(Result.getOrThrow(ContextWindow.compact(ContextWindow.empty("m"), Request.Message.user("s"))).segments)
        .toEqual([])
    })

    it("treats summary and steering segments as compactable", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [
          { kind: "summary", zone: "tail", content: [Request.Message.user("prior summary")] },
          { kind: "steering", zone: "tail", content: [Request.Message.user("steer")] },
          { kind: "transcript", zone: "tail", content: [Request.Message.user("latest")] }
        ]
      })
      const compacted = Result.getOrThrow(ContextWindow.compact(value, Request.Message.user("merged")))
      expect(compacted.segments.map((segment) => segment.kind)).toEqual(["summary", "transcript"])
      expect(texts(ContextWindow.render(compacted))).toEqual(["merged", "latest"])
    })
  })

  describe("render", () => {
    it("renders an empty window as an empty request", () => {
      const request = ContextWindow.render(ContextWindow.empty("test-model"))
      expect(request.modelId).toBe("test-model")
      expect(request.system).toEqual([])
      expect(request.messages).toEqual([])
      expect(request.tools).toEqual([])
      expect(request.params).toEqual(Request.GenerationParams.make())
    })

    it("carries the window's model id, whatever it is", () => {
      for (const modelId of ["", "claude-sonnet-4-5", "gpt-5.6-sol"]) {
        expect(ContextWindow.render(ContextWindow.empty(modelId)).modelId).toBe(modelId)
      }
    })

    it("collects system parts, messages, and tools by their shape, in segment order", () => {
      const request = ContextWindow.render(base())
      expect(request.system.map((part) => part.text)).toEqual(["Be concise.", "Follow instructions"])
      expect(texts(request)).toEqual(["first", "second"])
      expect(request.tools.map((definition) => definition.name)).toEqual(["read"])
    })

    it("omits a declared tool that is neither deferred nor active", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [{ kind: "tools", zone: "prefix", content: [tool] }],
        activeTools: []
      })
      expect(ContextWindow.render(value).tools).toEqual([])
    })

    it("keeps the last declaration when the same tool name is declared twice", () => {
      const upper = Request.ToolDefinition.make({ name: "Read", description: "first", parameters: {} })
      const lower = Request.ToolDefinition.make({ name: " read ", description: "second", parameters: {} })
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [{ kind: "tools", zone: "prefix", content: [upper, lower] }],
        activeTools: ["READ"]
      })
      expect(ContextWindow.render(value).tools).toEqual([lower])
    })

    it("matches an active name against a declaration regardless of case and padding", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [{ kind: "tools", zone: "prefix", content: [tool] }],
        activeTools: [" ReAd "]
      })
      expect(ContextWindow.render(value).tools).toEqual([tool])
    })
  })

  describe("activation and compaction together", () => {
    it("holds the sealed prefix steady across a compaction followed by an activation", () => {
      const value = lazy()
      const compacted = Result.getOrThrow(ContextWindow.compact(value, Request.Message.user("summary")))
      const activated = ContextWindow.activateTools(compacted, ["write"])

      // Compaction only ever rewrites tail segments, so the cached prefix and
      // the deferred declaration both survive the round trip.
      expect(sealedPrefix(activated)).toEqual(sealedPrefix(value))
      expect(activated.tokens.prefix).toEqual(value.tokens.prefix)
      expect(activated.replaced).toBe(compacted.replaced)
      expect(ContextWindow.render(activated).tools.map((definition) => definition.name)).toEqual(["write"])
    })

    it("reaches the same window whichever of activation and compaction runs first", () => {
      const value = lazy()
      const compactFirst = ContextWindow.activateTools(
        Result.getOrThrow(ContextWindow.compact(value, Request.Message.user("summary"))),
        ["write"]
      )
      const activateFirst = Result.getOrThrow(
        ContextWindow.compact(ContextWindow.activateTools(value, ["write"]), Request.Message.user("summary"))
      )
      expect(compactFirst.digest).toBe(activateFirst.digest)
    })
  })
})

describe("ContextWindow.contextWindowTokensFor", () => {
  it.each([
    ["claude-haiku-4-5", 200_000],
    ["CLAUDE-OPUS-5", 1_000_000],
    ["gpt-5", 400_000],
    ["gpt-4.1-mini", 1_000_000],
    ["gpt-4o", 128_000],
    ["o3-mini", 200_000],
    ["unknown", 128_000]
  ])("budgets %s at %i tokens", (model, tokens) => {
    expect(ContextWindow.contextWindowTokensFor(model)).toBe(tokens)
  })

  // The native million-token rows and the invariant they were added under: a
  // row is anchored to the bare id, so a cloud-prefixed or suffixed id falls
  // through to the conservative Claude row. This catalogue is re-exported by
  // `@smthrs/agent`, and pinning it only there let a dropped anchor pass this
  // package's own suite.
  it.each([
    ["claude-opus-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["claude-opus-4-6", 1_000_000],
    ["claude-sonnet-4-6", 1_000_000],
    ["claude-fable-5-1", 1_000_000],
    ["claude-mythos-5", 1_000_000],
    ["us.anthropic.claude-opus-4-6-v1", 200_000],
    ["publishers/anthropic/models/claude-opus-5@20260101", 200_000],
    ["claude-opus-5-1", 200_000],
    ["claude-sonnet-4-5", 200_000]
  ])("budgets %s at %i tokens", (model, tokens) => {
    expect(ContextWindow.contextWindowTokensFor(model)).toBe(tokens)
  })
})
