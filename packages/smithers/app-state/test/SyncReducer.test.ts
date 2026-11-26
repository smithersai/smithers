import { createHash } from "node:crypto"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  type AppState,
  applyAll,
  applyCommit,
  bumpEpoch,
  canonicalHash,
  canonicalJson,
  childrenOf,
  Command as CommandSchema,
  type Command,
  decide,
  type DomainEvent,
  Envelope,
  evolve,
  initialAppState,
  initialReplica,
  initialShardState,
  installSnapshot,
  MAX_LABEL_LENGTH,
  MAX_MARK_LENGTH,
  MAX_PARTS,
  MAX_SUMMARY_LENGTH,
  rebasePending,
  referenceMachine,
  sha256Hex,
  ShardState,
  submit,
  toPlanNodes
} from "../src/index.ts"

const upsert = (id: string, parent: string | null, extra: Partial<Extract<Command, { _tag: "UpsertPlanNode" }>> = {}): Command => ({
  _tag: "UpsertPlanNode",
  id,
  parent,
  title: `title ${id}`,
  milestone: "M0",
  sources: [],
  assumptions: ["holds"],
  dodFast: "pnpm test",
  order: 0,
  expectedRevision: null,
  ...extra
})

const move = (id: string, newParent: string | null, order = 0, expectedRevision: number | null = null): Command => ({
  _tag: "MovePlanNode",
  id,
  newParent,
  order,
  expectedRevision
})

/** Apply commands in order through a fresh shard; every command must be accepted. */
const build = (commands: ReadonlyArray<Command>): ShardState =>
  commands.reduce((shard, command, index) => {
    const { result, state } = submit(shard, { epoch: shard.epoch, origin: "t", commandId: `c${index}`, command })
    expect(result._tag, JSON.stringify(command)).toBe("Accepted")
    return state
  }, initialShardState)

const reasonOf = (state: AppState, command: Command): string => {
  const decision = decide(state, command)
  return decision._tag === "Refused" ? decision.reason : `accepted:${decision.events.length}`
}

describe("canonicalHash", () => {
  it("matches the SHA-256 test vectors and node:crypto", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const text = Array.from({ length }, (_, i) => String.fromCodePoint(32 + ((i * 7919) % 2000))).join("")
      expect(sha256Hex(text), `length ${length}`).toBe(createHash("sha256").update(text).digest("hex"))
    }
  })

  it("sorts keys, so the hash ignores insertion order", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x\n"], c: { z: 1.5, y: -0 } })).toBe(
      "{\"a\":[true,null,\"x\\n\"],\"b\":1,\"c\":{\"y\":0,\"z\":1.5}}"
    )
    const forward = build([upsert("a", null), upsert("b", null)])
    const backward = build([upsert("b", null), upsert("a", null)])
    expect(canonicalHash(forward.state.plan.nodes)).toBe(canonicalHash(backward.state.plan.nodes))
    expect(Object.keys(forward.state.plan.nodes)).not.toEqual(Object.keys(backward.state.plan.nodes))
  })

  it("refuses values JSON cannot represent", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
    expect(() => canonicalJson(1n)).toThrow(TypeError)
    expect(canonicalJson({ a: undefined, b: 1 })).toBe("{\"b\":1}")
  })
})

describe("plan tree", () => {
  const tree = build([upsert("root", null), upsert("a", "root"), upsert("b", "a"), upsert("c", "b")])

  it("requires an existing parent", () => {
    expect(reasonOf(tree.state, upsert("x", "nope"))).toBe("parent_missing")
    expect(reasonOf(tree.state, move("a", "nope"))).toBe("parent_missing")
    expect(reasonOf(tree.state, move("nope", "a"))).toBe("node_missing")
  })

  it("refuses every move that would create a cycle", () => {
    expect(reasonOf(tree.state, move("a", "a"))).toBe("cycle")
    expect(reasonOf(tree.state, move("a", "b"))).toBe("cycle")
    expect(reasonOf(tree.state, move("a", "c"))).toBe("cycle")
    expect(reasonOf(tree.state, move("root", "c"))).toBe("cycle")
    expect(reasonOf(tree.state, move("c", "root"))).toBe("accepted:1")
    expect(reasonOf(tree.state, move("b", null))).toBe("accepted:1")
  })

  it("checks the expected tree revision", () => {
    expect(tree.state.plan.revision).toBe(4)
    expect(reasonOf(tree.state, move("c", "root", 0, 3))).toBe("revision_mismatch")
    expect(reasonOf(tree.state, move("c", "root", 0, 4))).toBe("accepted:1")
    expect(reasonOf(tree.state, upsert("z", null, { expectedRevision: 9 }))).toBe("revision_mismatch")
  })

  it("refuses an upsert that would silently re-parent", () => {
    expect(reasonOf(tree.state, upsert("b", "root"))).toBe("parent_mismatch")
    expect(reasonOf(tree.state, upsert("b", "a", { title: "renamed" }))).toBe("accepted:1")
  })

  it("orders siblings by (order, id) whatever the insertion order", () => {
    const one = build([
      upsert("p", null),
      upsert("k2", "p", { order: 2 }),
      upsert("k1b", "p", { order: 1 }),
      upsert("k1a", "p", { order: 1 }),
      upsert("k0", "p", { order: 0 })
    ])
    const two = build([
      upsert("p", null),
      upsert("k0", "p", { order: 0 }),
      upsert("k1a", "p", { order: 1 }),
      upsert("k2", "p", { order: 2 }),
      upsert("k1b", "p", { order: 1 })
    ])
    expect(childrenOf(one.state.plan, "p")).toEqual(["k0", "k1a", "k1b", "k2"])
    expect(childrenOf(two.state.plan, "p")).toEqual(["k0", "k1a", "k1b", "k2"])
    expect(childrenOf(one.state.plan, null)).toEqual(["p"])
    const moved = build([upsert("p", null), upsert("x", "p", { order: 5 }), upsert("y", "p", { order: 6 }), move("y", "p", 1)])
    expect(childrenOf(moved.state.plan, "p")).toEqual(["y", "x"])
    expect(toPlanNodes(moved.state.plan).find((node) => node.id === "p")?.children).toEqual(["y", "x"])
  })

  it("toggles assumptions, sets status, and attaches artifacts once", () => {
    const shard = build([
      upsert("n", null, { assumptions: ["first", "second"] }),
      { _tag: "ToggleAssumption", nodeId: "n", index: 1, expectedRevision: null },
      { _tag: "SetNodeStatus", nodeId: "n", status: "blocked_on_will", expectedRevision: null },
      { _tag: "AttachArtifact", nodeId: "n", artifactId: "art-1", expectedRevision: null },
      { _tag: "AttachArtifact", nodeId: "n", artifactId: "art-1", expectedRevision: null }
    ])
    const node = shard.state.plan.nodes["n"]
    expect(node?.assumptions).toEqual([{ text: "first", verified: false }, { text: "second", verified: true }])
    expect(node?.status).toBe("blocked_on_will")
    expect(node?.artifactIds).toEqual(["art-1"])
    expect(shard.headSeq).toBe(4)
    expect(reasonOf(shard.state, { _tag: "ToggleAssumption", nodeId: "n", index: 2, expectedRevision: null })).toBe(
      "assumption_missing"
    )
    expect(reasonOf(shard.state, { _tag: "ToggleAssumption", nodeId: "n", index: -1, expectedRevision: null })).toBe(
      "assumption_missing"
    )
    expect(reasonOf(shard.state, { _tag: "SetNodeStatus", nodeId: "gone", status: "done", expectedRevision: null }))
      .toBe("node_missing")
    const renamed = build([
      upsert("n", null, { assumptions: ["first", "second"] }),
      { _tag: "ToggleAssumption", nodeId: "n", index: 0, expectedRevision: null },
      { _tag: "ToggleAssumption", nodeId: "n", index: 1, expectedRevision: null },
      upsert("n", null, { assumptions: ["first", "changed", "added"] })
    ])
    expect(renamed.state.plan.nodes["n"]?.assumptions).toEqual([
      { text: "first", verified: true },
      { text: "changed", verified: false },
      { text: "added", verified: false }
    ])
  })

  it("refuses a negative or fractional order at the wire, as Lean's Nat does", () => {
    const decodeCommand = Schema.decodeUnknownExit(CommandSchema)
    const decodeEnvelope = Schema.decodeUnknownExit(Envelope)
    for (const order of [-1, -0.5, 0.5, Number.MIN_SAFE_INTEGER]) {
      expect(decodeCommand(upsert("n", null, { order }))._tag, `upsert order ${order}`).toBe("Failure")
      expect(decodeCommand(move("n", null, order))._tag, `move order ${order}`).toBe("Failure")
      expect(
        decodeEnvelope({ epoch: 0, origin: "o", commandId: "c", command: upsert("n", null, { order }) })._tag,
        `envelope order ${order}`
      ).toBe("Failure")
    }
    for (const order of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(decodeCommand(upsert("n", null, { order }))._tag, `upsert order ${order}`).toBe("Success")
      expect(decodeCommand(move("n", null, order))._tag, `move order ${order}`).toBe("Success")
    }
    const created = build([upsert("n", null)])
    const tampered = { ...created, state: { ...created.state, plan: { ...created.state.plan, nodes: { n: { ...created.state.plan.nodes["n"]!, order: -1 } } } } }
    expect(Schema.decodeUnknownExit(ShardState)(JSON.parse(canonicalJson(tampered)))._tag).toBe("Failure")
  })

  it("is not confused by ids that name Object.prototype members", () => {
    expect(reasonOf(initialAppState, move("constructor", null))).toBe("node_missing")
    const shard = build([upsert("__proto__", null), upsert("constructor", "__proto__")])
    expect(childrenOf(shard.state.plan, "__proto__")).toEqual(["constructor"])
  })
})

describe("chat", () => {
  const post = (messageId: string, body: string, author = "will"): Command => ({ _tag: "PostMessage", messageId, author, body })
  const status = (messageId: string, value: "posted" | "streaming" | "complete" | "failed"): Command => ({
    _tag: "UpdateMessageStatus",
    messageId,
    status: value
  })

  it("appends in hubSeq order and stamps each message", () => {
    const shard = build([post("m1", "one"), upsert("n", null), post("m2", "two")])
    expect(shard.state.chat.messages.map((message) => [message.id, message.hubSeq])).toEqual([["m1", 1], ["m2", 3]])
  })

  it("treats the same id and content as a no-op and different content as a conflict", () => {
    const shard = build([post("m1", "one")])
    expect(reasonOf(shard.state, post("m1", "one"))).toBe("accepted:0")
    expect(reasonOf(shard.state, post("m1", "other"))).toBe("message_conflict")
    expect(reasonOf(shard.state, post("m1", "one", "someone-else"))).toBe("message_conflict")
  })

  it("never overwrites a terminal status", () => {
    const shard = build([post("m1", "one"), status("m1", "streaming"), status("m1", "complete")])
    expect(reasonOf(shard.state, status("m1", "failed"))).toBe("terminal_status")
    expect(reasonOf(shard.state, status("m1", "complete"))).toBe("accepted:0")
    expect(reasonOf(shard.state, status("nope", "complete"))).toBe("message_missing")
  })

  type Post = Extract<Command, { _tag: "PostMessage" }>
  type Metadata = Omit<Extract<Command, { _tag: "UpdateMessageMetadata" }>, "_tag" | "messageId">
  const meta = (messageId: string, fields: Metadata): Command => ({ _tag: "UpdateMessageMetadata", messageId, ...fields })
  const origin = { role: "assistant", questionId: "q1", position: 7, createdAt: "2026-11-25T10:00:00Z" } as const
  const answer: Post = { _tag: "PostMessage", messageId: "a1", author: "run", body: "", ...origin }
  const step = (id: string, state: "running" | "done" | "failed") =>
    ({ id, kind: "step", flow: "chat/copy", status: state }) as const

  it("keeps a message, a command, an event, and a snapshot from before the added fields exactly as they were", () => {
    const shard = build([post("m1", "one")])
    expect(shard.state.chat.messages).toEqual([{ id: "m1", author: "will", body: "one", status: "posted", hubSeq: 1 }])
    expect(Object.keys(shard.state.chat.messages[0]!)).toEqual(["id", "author", "body", "status", "hubSeq"])
    expect(shard.log[0]!.event).toEqual({ _tag: "MessagePosted", id: "m1", author: "will", body: "one" })
    // The five-field shard of the previous model decodes, and hashes to what the extended model holds.
    const legacy = {
      epoch: 0,
      headSeq: 1,
      state: { plan: { revision: 0, nodes: {} }, chat: { messages: [{ id: "m1", author: "will", body: "one", status: "posted", hubSeq: 1 }] } },
      receipts: {
        [JSON.stringify(["t", "c0"])]: { origin: "t", commandId: "c0", command: { _tag: "PostMessage", messageId: "m1", author: "will", body: "one" }, firstSeq: 1, count: 1 }
      },
      log: [{ hubSeq: 1, epoch: 0, origin: "t", commandId: "c0", event: { _tag: "MessagePosted", id: "m1", author: "will", body: "one" } }]
    }
    expect(canonicalJson(shard)).toBe(canonicalJson(legacy))
    expect(canonicalHash(Schema.decodeUnknownSync(ShardState)(JSON.parse(JSON.stringify(legacy))))).toBe(canonicalHash(shard))
  })

  it("stores what the post says about the message, and compares it on a repeated post", () => {
    const shard = build([answer])
    expect(shard.state.chat.messages).toEqual([{ id: "a1", author: "run", body: "", status: "posted", hubSeq: 1, ...origin }])
    expect(shard.log[0]!.event).toEqual({ _tag: "MessagePosted", id: "a1", author: "run", body: "", ...origin })
    expect(reasonOf(shard.state, answer)).toBe("accepted:0")
    expect(reasonOf(shard.state, { ...answer, role: "user" })).toBe("message_conflict")
    expect(reasonOf(shard.state, { ...answer, position: 8 })).toBe("message_conflict")
    const { questionId: _, ...unlinked } = answer
    expect(reasonOf(shard.state, unlinked)).toBe("message_conflict")
    // A post without origin fields over one that has none is the same post; over one that has some, it is not.
    expect(reasonOf(build([post("m1", "one")]).state, { ...post("m1", "one"), role: "user" } as Command)).toBe("message_conflict")
  })

  it("patches metadata field by field while a message streams", () => {
    const shard = build([
      answer,
      status("a1", "streaming"),
      meta("a1", { parts: [step("0.0", "running")], modelId: "m-large", inputTokens: 12 }),
      meta("a1", { parts: [step("0.0", "done"), step("0.1", "running")], outputTokens: 3, updatedAt: "t1" }),
      meta("a1", { outputTokens: 40, stopReason: "end_turn", summary: "s", summaryRevision: "r", phase: "{}", arc: "[]" })
    ])
    expect(shard.state.chat.messages).toEqual([{
      id: "a1",
      author: "run",
      body: "",
      status: "streaming",
      hubSeq: 1,
      ...origin,
      parts: [step("0.0", "done"), step("0.1", "running")],
      modelId: "m-large",
      stopReason: "end_turn",
      inputTokens: 12,
      outputTokens: 40,
      summary: "s",
      summaryRevision: "r",
      phase: "{}",
      arc: "[]",
      updatedAt: "t1"
    }])
    expect(shard.log[3]!.event).toEqual({
      _tag: "MessageMetadataUpdated",
      id: "a1",
      parts: [step("0.0", "done"), step("0.1", "running")],
      outputTokens: 3,
      updatedAt: "t1"
    })
    // A patch that changes nothing, an empty one included, takes no hubSeq.
    expect(reasonOf(shard.state, meta("a1", {}))).toBe("accepted:0")
    expect(reasonOf(shard.state, meta("a1", { inputTokens: 12, summary: "s" }))).toBe("accepted:0")
    expect(reasonOf(shard.state, meta("a1", { parts: [step("0.0", "done"), step("0.1", "running")] }))).toBe("accepted:0")
    expect(reasonOf(shard.state, meta("a1", { parts: [] }))).toBe("accepted:1")
    expect(reasonOf(shard.state, meta("nope", { summary: "s" }))).toBe("message_missing")
    // An explicit `undefined` is an absent field: it erases nothing.
    const sparse = { _tag: "UpdateMessageMetadata", messageId: "a1", modelId: undefined, summary: "s2" } as unknown as Command
    const next = submit(shard, { epoch: 0, origin: "t", commandId: "sparse", command: sparse }).state
    expect(next.state.chat.messages[0]).toMatchObject({ modelId: "m-large", summary: "s2" })
    expect(Object.keys(next.log.at(-1)!.event).sort()).toEqual(["_tag", "id", "summary"])
  })

  it("freezes run metadata once the status is terminal, and still takes notes", () => {
    for (const terminal of ["complete", "failed"] as const) {
      const ended = [
        answer,
        meta("a1", { parts: [step("0.0", "done")], failure: "empty", inputTokens: 1 }),
        status("a1", terminal)
      ]
      const shard = build(ended)
      expect(reasonOf(shard.state, meta("a1", { inputTokens: 2 }))).toBe("terminal_metadata")
      expect(reasonOf(shard.state, meta("a1", { outputTokens: 0 }))).toBe("terminal_metadata")
      expect(reasonOf(shard.state, meta("a1", { failure: "quota" }))).toBe("terminal_metadata")
      expect(reasonOf(shard.state, meta("a1", { parts: [step("0.0", "failed")] }))).toBe("terminal_metadata")
      expect(reasonOf(shard.state, meta("a1", { modelId: "m" }))).toBe("terminal_metadata")
      expect(reasonOf(shard.state, meta("a1", { stopReason: "end_turn" }))).toBe("terminal_metadata")
      // One changed run field refuses the whole patch, notes included.
      expect(reasonOf(shard.state, meta("a1", { summary: "s", inputTokens: 2 }))).toBe("terminal_metadata")
      // The same run values with new notes: accepted, and the status stays where it ended.
      const noted = build([...ended, meta("a1", { inputTokens: 1, summary: "s", phase: "{}", arc: "[]", updatedAt: "t2" })])
      expect(noted.state.chat.messages[0]).toMatchObject({ status: terminal, inputTokens: 1, summary: "s", updatedAt: "t2" })
      expect(noted.state.chat.messages[0]).toMatchObject(shard.state.chat.messages[0]!)
      expect(reasonOf(noted.state, status("a1", "streaming"))).toBe("terminal_status")
    }
  })

  it("never aliases a command's parts into an event or the state", () => {
    const parts = [{ id: "0.0", kind: "step" as const, flow: "chat/copy", status: "running" as "running" | "done" }]
    const posted = build([answer]).state
    const decision = decide(posted, meta("a1", { parts }))
    const event = (decision as { events: ReadonlyArray<DomainEvent> }).events[0]!
    const state = evolve(posted, { hubSeq: 2, epoch: 0, origin: "t", commandId: "c", event })
    parts[0]!.status = "done"
    parts.push({ id: "0.1", kind: "step", flow: "chat/edit", status: "running" })
    expect(event).toEqual({ _tag: "MessageMetadataUpdated", id: "a1", parts: [step("0.0", "running")] })
    ;(event as unknown as { parts: Array<unknown> }).parts.length = 0
    expect(state.chat.messages[0]!.parts).toEqual([step("0.0", "running")])
  })

  it("refuses a negative or fractional count or position at the wire, as Lean's Nat does", () => {
    const decode = Schema.decodeUnknownExit(CommandSchema)
    for (const value of [-1, 0.5]) {
      expect(decode({ ...answer, position: value })._tag).toBe("Failure")
      expect(decode(meta("a1", { inputTokens: value }))._tag).toBe("Failure")
      expect(decode(meta("a1", { outputTokens: value }))._tag).toBe("Failure")
    }
    expect(decode({ ...answer, role: "system" })._tag).toBe("Failure")
    expect(decode(meta("a1", { failure: "nope" as "quota" }))._tag).toBe("Failure")
    expect(decode({ ...meta("a1", {}), parts: [{ id: "0.0", kind: "tool", flow: "f", status: "done" }] })._tag).toBe("Failure")
    expect(decode(answer)._tag).toBe("Success")
    expect(decode(meta("a1", { parts: [step("0.0", "done")], inputTokens: 0, failure: "unfinished" }))._tag).toBe("Success")
  })

  it("posts a message with its first run and notes as one command and one event", () => {
    const born: Post = { ...answer, parts: [step("0.0", "running")], modelId: "m-large", summary: "a summary" }
    const shard = build([born])
    const { _tag: _, messageId, ...said } = born
    expect(shard.log).toHaveLength(1)
    expect(shard.log[0]!.event).toEqual({ _tag: "MessagePosted", id: messageId, ...said })
    expect(shard.state.chat.messages).toEqual([{ id: messageId, status: "posted", hubSeq: 1, ...said }])
    // The post again, or with less: everything it says already holds.
    expect(reasonOf(shard.state, born)).toBe("accepted:0")
    expect(reasonOf(shard.state, answer)).toBe("accepted:0")
    expect(reasonOf(shard.state, { ...answer, summary: "a summary" })).toBe("accepted:0")
    // The posted parts are the event's own copy.
    ;(born.parts as Array<unknown>).length = 0
    expect(shard.state.chat.messages[0]!.parts).toEqual([step("0.0", "running")])
  })

  it("never lets a post change a message that exists: other run fields or notes are a conflict", () => {
    const first: Post = { ...answer, modelId: "m-large", summary: "the first summary" }
    const shard = build([first])
    for (const other of [
      { ...first, summary: "the second summary" },
      { ...first, modelId: "m-small" },
      { ...first, phase: "{}" },
      { ...answer, inputTokens: 1 },
      { ...first, body: "other text", summary: "the second summary" }
    ] satisfies ReadonlyArray<Post>) {
      const { result, state } = submit(shard, { epoch: 0, origin: "elsewhere", commandId: "c", command: other })
      expect(result).toEqual({ _tag: "Refused", reason: "message_conflict" })
      expect(state).toBe(shard)
      expect(rebasePending(shard.state, [other]).state).toBe(shard.state)
    }
    expect(shard.state.chat.messages[0]).toMatchObject({ body: "", modelId: "m-large", summary: "the first summary" })
    // Once a later patch has moved a field, the post that named its old value no longer holds.
    const moved = build([first, meta("a1", { summary: "rewritten" })])
    expect(reasonOf(moved.state, first)).toBe("message_conflict")
    expect(reasonOf(moved.state, answer)).toBe("accepted:0")
  })

  it("bounds every added string and list at the wire, on a post and on a patch alike", () => {
    const decode = Schema.decodeUnknownExit(CommandSchema)
    const text = (length: number) => "x".repeat(length)
    const steps = (count: number) => Array.from({ length: count }, (_, index) => step(`0.${index}`, "done"))
    expect([MAX_SUMMARY_LENGTH, MAX_MARK_LENGTH, MAX_PARTS, MAX_LABEL_LENGTH]).toEqual([96, 512, 64, 256])
    const within: Metadata = {
      summary: text(96),
      phase: text(512),
      arc: text(512),
      parts: steps(64),
      modelId: text(256),
      stopReason: text(256),
      summaryRevision: text(256),
      updatedAt: text(256)
    }
    expect(decode(meta("a1", within))._tag).toBe("Success")
    expect(decode({ ...answer, ...within, questionId: text(256), createdAt: text(256) })._tag).toBe("Success")
    const over: ReadonlyArray<Record<string, unknown>> = [
      { summary: text(97) },
      { phase: text(513) },
      { arc: text(513) },
      { parts: steps(65) },
      { parts: [{ ...step("0.0", "done"), id: text(257) }] },
      { parts: [{ ...step("0.0", "done"), flow: text(257) }] },
      { modelId: text(257) },
      { stopReason: text(257) },
      { summaryRevision: text(257) },
      { updatedAt: text(257) }
    ]
    for (const fields of over) {
      expect(decode({ ...meta("a1", {}), ...fields })._tag, Object.keys(fields)[0]).toBe("Failure")
      expect(decode({ ...answer, ...fields })._tag, Object.keys(fields)[0]).toBe("Failure")
    }
    expect(decode({ ...answer, questionId: text(257) })._tag).toBe("Failure")
    expect(decode({ ...answer, createdAt: text(257) })._tag).toBe("Failure")
    // A stored message and an event are held to the same bounds: nothing longer is ever folded.
    const state = { ...initialShardState, state: { plan: initialAppState.plan, chat: { messages: [{ id: "m", author: "a", body: "", status: "posted", hubSeq: 1, summary: text(97) }] } } }
    expect(Schema.decodeUnknownExit(ShardState)(state)._tag).toBe("Failure")
  })

  it("decodes a command to its declared fields only: what the schema does not name is dropped", () => {
    const decode = Schema.decodeUnknownSync(CommandSchema)
    const extra = { __proto__: null, smuggled: { deep: [1, 2, 3] }, hubSeq: 99, status: "complete" }
    expect(decode({ ...answer, summary: "s", ...extra })).toEqual({ ...answer, summary: "s" })
    expect(decode({ ...meta("a1", { parts: [{ ...step("0.0", "done"), smuggled: true } as never] }), ...extra }))
      .toEqual(meta("a1", { parts: [step("0.0", "done")] }))
    expect(decode({ ...status("a1", "complete"), smuggled: 1, summary: "s" })).toEqual(status("a1", "complete"))
  })
})

describe("sync envelope", () => {
  const envelope = (commandId: string, command: Command, epoch = 0, origin = "node-a") => ({ epoch, origin, commandId, command })

  it("assigns gapless hubSeq and keeps one receipt per (origin, commandId)", () => {
    const shard = build([upsert("a", null), upsert("b", "a"), move("b", null)])
    expect(shard.log.map((commit) => commit.hubSeq)).toEqual([1, 2, 3])
    expect(shard.headSeq).toBe(3)
    expect(Object.keys(shard.receipts)).toHaveLength(3)
  })

  it("answers a retry with Duplicate and changes nothing", () => {
    const first = submit(initialShardState, envelope("c1", upsert("a", null)))
    expect(first.result).toEqual({ _tag: "Accepted", firstSeq: 1, count: 1 })
    const retry = submit(first.state, envelope("c1", upsert("a", null)))
    expect(retry.result).toEqual({ _tag: "Duplicate", firstSeq: 1, count: 1 })
    expect(retry.state).toBe(first.state)
    const otherOrigin = submit(first.state, envelope("c1", upsert("b", null), 0, "node-b"))
    expect(otherOrigin.result._tag).toBe("Accepted")
  })

  it("refuses the same commandId with a different payload", () => {
    const first = submit(initialShardState, envelope("c1", upsert("a", null)))
    const conflict = submit(first.state, envelope("c1", upsert("a", null, { title: "different" })))
    expect(conflict.result).toEqual({ _tag: "Refused", reason: "idempotency_conflict" })
    expect(conflict.state).toBe(first.state)
  })

  it("leaves no receipt for a refused command, so it can succeed later", () => {
    const refusedFirst = submit(initialShardState, envelope("c1", upsert("child", "parent")))
    expect(refusedFirst.result).toEqual({ _tag: "Refused", reason: "parent_missing" })
    const withParent = submit(refusedFirst.state, envelope("c0", upsert("parent", null)))
    expect(submit(withParent.state, envelope("c1", upsert("child", "parent"))).result._tag).toBe("Accepted")
  })

  it("snapshots the command at admission, so later caller edits change nothing", () => {
    const sources = ["spec.md"]
    const assumptions = ["holds"]
    const command = upsert("a", null, { sources, assumptions }) as Extract<Command, { _tag: "UpsertPlanNode" }>
    const env = envelope("c1", command)
    const first = submit(initialShardState, env)
    expect(first.result).toEqual({ _tag: "Accepted", firstSeq: 1, count: 1 })
    const hashBefore = canonicalHash(first.state)
    const receiptBefore = canonicalJson(first.state.receipts)

    sources.push("injected.md")
    assumptions[0] = "rewritten"
    ;(command as { title: string }).title = "rewritten title"
    ;(env as { command: Command }).command = upsert("a", null, { title: "swapped" })

    expect(canonicalHash(first.state)).toBe(hashBefore)
    expect(canonicalJson(first.state.receipts)).toBe(receiptBefore)
    expect(first.state.state.plan.nodes["a"]?.sources).toEqual(["spec.md"])
    expect(first.state.state.plan.nodes["a"]?.assumptions).toEqual([{ text: "holds", verified: false }])
    const event = first.state.log[0]!.event as { sources: ReadonlyArray<string>; title: string }
    expect(event.sources).toEqual(["spec.md"])
    expect(event.title).toBe("title a")

    // Duplicate detection still compares against what was admitted.
    expect(submit(first.state, envelope("c1", upsert("a", null, { sources: ["spec.md"] }))).result)
      .toEqual({ _tag: "Duplicate", firstSeq: 1, count: 1 })
    expect(submit(first.state, envelope("c1", command)).result)
      .toEqual({ _tag: "Refused", reason: "idempotency_conflict" })
  })

  it("decide never aliases the command's arrays into its events", () => {
    const sources = ["spec.md"]
    const decision = decide(initialAppState, upsert("a", null, { sources }))
    expect(decision._tag).toBe("Accepted")
    sources.push("injected.md")
    const event = (decision as { events: ReadonlyArray<{ sources: ReadonlyArray<string> }> }).events[0]!
    expect(event.sources).toEqual(["spec.md"])
  })

  it("fences every writer on a stale generation", () => {
    const first = submit(initialShardState, envelope("c1", upsert("a", null)))
    const bumped = bumpEpoch(first.state)
    const stale = submit(bumped, envelope("c2", upsert("b", null), 0))
    expect(stale.result).toEqual({ _tag: "EpochMismatch", current: 1 })
    expect(stale.state).toBe(bumped)
    expect(submit(bumped, envelope("c2", upsert("b", null), 2)).result._tag).toBe("EpochMismatch")
    expect(submit(bumped, envelope("c2", upsert("b", null), 1)).result._tag).toBe("Accepted")
  })

  it("applies commits in order only, and never from a stale generation", () => {
    const shard = build([upsert("a", null), upsert("b", "a"), move("b", null)])
    const [one, two, three] = shard.log as [typeof shard.log[number], typeof shard.log[number], typeof shard.log[number]]
    expect(applyCommit(initialReplica, two).result).toBe("Gap")
    const afterOne = applyCommit(initialReplica, one)
    expect(afterOne.result).toBe("Applied")
    expect(applyCommit(afterOne.replica, one).result).toBe("Duplicate")
    expect(applyCommit(afterOne.replica, three).result).toBe("Gap")
    const caughtUp = applyAll(initialReplica, [two, one, one, three, two, three])
    expect(caughtUp.cursor).toBe(3)
    expect(canonicalHash(caughtUp.confirmed)).toBe(canonicalHash(shard.state))
    const resynced = installSnapshot(afterOne.replica, 1, 3, shard.state)
    expect(applyCommit(resynced, two).result).toBe("StaleEpoch")
    expect(applyCommit(afterOne.replica, { ...three, hubSeq: 2, epoch: 1 }).result).toBe("EpochAhead")
    expect(installSnapshot(resynced, 1, 0, initialAppState)).toBe(resynced)
  })

  it("rebases pending commands over a confirmed state", () => {
    const confirmed = build([upsert("a", null), upsert("b", "a")]).state
    const rebased = rebasePending(confirmed, [
      move("a", "b"),
      upsert("c", "b"),
      { _tag: "PostMessage", messageId: "m", author: "will", body: "hi" },
      move("b", "c")
    ])
    expect(rebased.decisions.map((decision) => decision._tag === "Refused" ? decision.reason : "ok")).toEqual([
      "cycle",
      "ok",
      "ok",
      "cycle"
    ])
    expect(rebased.state.plan.nodes["c"]?.parent).toBe("b")
    expect(rebased.state.chat.messages).toEqual([{ id: "m", author: "will", body: "hi", status: "posted", hubSeq: 0 }])
    expect(rebasePending(confirmed, []).state).toBe(confirmed)
  })

  it("exposes the Gate 1 reference machine and survives a JSON round trip through Schema", () => {
    const shard = build([upsert("a", null), { _tag: "PostMessage", messageId: "m", author: "will", body: "hi" }])
    const decoded = Schema.decodeUnknownSync(ShardState)(JSON.parse(canonicalJson(shard)))
    expect(canonicalHash(decoded)).toBe(canonicalHash(shard))
    expect(() => Schema.decodeUnknownSync(ShardState)({ ...shard, headSeq: 1.5 })).toThrow()
    const replayed = shard.log.reduce(referenceMachine.evolve, referenceMachine.initial)
    expect(referenceMachine.canonicalHash(replayed)).toBe(referenceMachine.canonicalHash(shard.state))
    expect(evolve(initialAppState, shard.log[0]!)).toEqual(replayed.chat.messages.length === 1 ? { ...replayed, chat: { messages: [] } } : replayed)
  })
})
