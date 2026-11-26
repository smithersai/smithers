import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  applyAll,
  applyCommit,
  type AppState,
  bumpEpoch,
  canonicalHash,
  canonicalJson,
  childrenOf,
  type Command,
  Command as CommandSchema,
  decide,
  type DomainEvent,
  Envelope,
  evolve,
  initialAppState,
  initialReplica,
  answerOwner,
  initialShardState,
  installSnapshot,
  isBridged,
  MAX_BODY_LENGTH,
  MAX_DATA_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_MARK_LENGTH,
  MAX_PARTS,
  MAX_SUMMARY_LENGTH,
  originOf,
  MAX_ADMITTED_POSITION,
  placeOf,
  placesOf,
  questionOwner,
  rebasePending,
  referenceMachine,
  sha256Hex,
  ShardState,
  submit,
  toPlanNodes
} from "../src/index.ts"

const upsert = (
  id: string,
  parent: string | null,
  extra: Partial<Extract<Command, { _tag: "UpsertPlanNode" }>> = {}
): Command => ({
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
    const moved = build([
      upsert("p", null),
      upsert("x", "p", { order: 5 }),
      upsert("y", "p", { order: 6 }),
      move("y", "p", 1)
    ])
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
    const tampered = {
      ...created,
      state: {
        ...created.state,
        plan: { ...created.state.plan, nodes: { n: { ...created.state.plan.nodes["n"]!, order: -1 } } }
      }
    }
    expect(Schema.decodeUnknownExit(ShardState)(JSON.parse(canonicalJson(tampered)))._tag).toBe("Failure")
  })

  it("is not confused by ids that name Object.prototype members", () => {
    expect(reasonOf(initialAppState, move("constructor", null))).toBe("node_missing")
    const shard = build([upsert("__proto__", null), upsert("constructor", "__proto__")])
    expect(childrenOf(shard.state.plan, "__proto__")).toEqual(["constructor"])
  })
})

describe("chat", () => {
  const post = (messageId: string, body: string, author = "will"): Command => ({
    _tag: "PostMessage",
    messageId,
    author,
    body
  })
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
  const meta = (messageId: string, fields: Metadata): Command => ({
    _tag: "UpdateMessageMetadata",
    messageId,
    ...fields
  })
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
      state: {
        plan: { revision: 0, nodes: {} },
        chat: { messages: [{ id: "m1", author: "will", body: "one", status: "posted", hubSeq: 1 }] }
      },
      receipts: {
        [JSON.stringify(["t", "c0"])]: {
          origin: "t",
          commandId: "c0",
          command: { _tag: "PostMessage", messageId: "m1", author: "will", body: "one" },
          firstSeq: 1,
          count: 1
        }
      },
      log: [{
        hubSeq: 1,
        epoch: 0,
        origin: "t",
        commandId: "c0",
        event: { _tag: "MessagePosted", id: "m1", author: "will", body: "one" }
      }]
    }
    expect(canonicalJson(shard)).toBe(canonicalJson(legacy))
    expect(canonicalHash(Schema.decodeUnknownSync(ShardState)(JSON.parse(JSON.stringify(legacy))))).toBe(
      canonicalHash(shard)
    )
  })

  it("stores what the post says about the message, and compares it on a repeated post", () => {
    const shard = build([answer])
    expect(shard.state.chat.messages).toEqual([{
      id: "a1",
      author: "run",
      body: "",
      status: "posted",
      hubSeq: 1,
      ...origin
    }])
    expect(shard.log[0]!.event).toEqual({ _tag: "MessagePosted", id: "a1", author: "run", body: "", ...origin })
    expect(reasonOf(shard.state, answer)).toBe("accepted:0")
    expect(reasonOf(shard.state, { ...answer, role: "user" })).toBe("message_conflict")
    expect(reasonOf(shard.state, { ...answer, position: 8 })).toBe("message_conflict")
    const { questionId: _, ...unlinked } = answer
    expect(reasonOf(shard.state, unlinked)).toBe("message_conflict")
    // A post without origin fields over one that has none is the same post; over one that has some, it is not.
    expect(reasonOf(build([post("m1", "one")]).state, { ...post("m1", "one"), role: "user" } as Command)).toBe(
      "message_conflict"
    )
  })

  it("patches metadata field by field while a message streams", () => {
    const shard = build([
      answer,
      status("a1", "streaming"),
      meta("a1", { parts: [step("0.0", "running")], modelId: "m-large", inputTokens: 12 }),
      meta("a1", { parts: [step("0.0", "done"), step("0.1", "running")], outputTokens: 3, updatedAt: "t1" }),
      meta("a1", {
        outputTokens: 40,
        stopReason: "end_turn",
        summary: "s",
        summaryRevision: "r",
        phase: "{}",
        arc: "[]"
      })
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
    expect(reasonOf(shard.state, meta("a1", { parts: [step("0.0", "done"), step("0.1", "running")] }))).toBe(
      "accepted:0"
    )
    expect(reasonOf(shard.state, meta("a1", { parts: [] }))).toBe("accepted:1")
    expect(reasonOf(shard.state, meta("nope", { summary: "s" }))).toBe("message_missing")
    // An explicit `undefined` is an absent field: it erases nothing.
    const sparse = {
      _tag: "UpdateMessageMetadata",
      messageId: "a1",
      modelId: undefined,
      summary: "s2"
    } as unknown as Command
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
      const noted = build([
        ...ended,
        meta("a1", { inputTokens: 1, summary: "s", phase: "{}", arc: "[]", updatedAt: "t2" })
      ])
      expect(noted.state.chat.messages[0]).toMatchObject({
        status: terminal,
        inputTokens: 1,
        summary: "s",
        updatedAt: "t2"
      })
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
    expect(decode({ ...meta("a1", {}), parts: [{ id: "0.0", kind: "tool", flow: "f", status: "done" }] })._tag).toBe(
      "Failure"
    )
    expect(decode(answer)._tag).toBe("Success")
    expect(decode(meta("a1", { parts: [step("0.0", "done")], inputTokens: 0, failure: "unfinished" }))._tag).toBe(
      "Success"
    )
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
    expect(reasonOf(shard.state, { ...answer, summary: "a summary" })).toBe("accepted:0") // The posted parts are the event's own copy.
    ;(born.parts as Array<unknown>).length = 0
    expect(shard.state.chat.messages[0]!.parts).toEqual([step("0.0", "running")])
  })

  it("never lets a post change a message that exists: other run fields or notes are a conflict", () => {
    const first: Post = { ...answer, modelId: "m-large", summary: "the first summary" }
    const shard = build([first])
    for (
      const other of [
        { ...first, summary: "the second summary" },
        { ...first, modelId: "m-small" },
        { ...first, phase: "{}" },
        { ...answer, inputTokens: 1 },
        { ...first, body: "other text", summary: "the second summary" }
      ] satisfies ReadonlyArray<Post>
    ) {
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
    const state = {
      ...initialShardState,
      state: {
        plan: initialAppState.plan,
        chat: { messages: [{ id: "m", author: "a", body: "", status: "posted", hubSeq: 1, summary: text(97) }] }
      }
    }
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

  const write = (messageId: string, body: string, author = "run"): Command => ({
    _tag: "UpdateMessageBody",
    messageId,
    author,
    body
  })

  it("extends a streaming body, whole body by whole body, and changes nothing else", () => {
    const shard = build([answer, post("m1", "one"), status("a1", "streaming"), meta("a1", { modelId: "m-large" })])
    const before = shard.state.chat.messages
    const grown = build([
      answer,
      post("m1", "one"),
      status("a1", "streaming"),
      meta("a1", { modelId: "m-large" }),
      write("a1", "Hel"),
      write("a1", "Hello, wor"),
      write("a1", "Hello, world")
    ])
    expect(grown.log.slice(4).map((commit) => commit.event)).toEqual([
      { _tag: "MessageBodyUpdated", id: "a1", body: "Hel" },
      { _tag: "MessageBodyUpdated", id: "a1", body: "Hello, wor" },
      { _tag: "MessageBodyUpdated", id: "a1", body: "Hello, world" }
    ])
    // Only the body moved: the id, author, hubSeq, origin, status and metadata are the ones the message had.
    expect(grown.state.chat.messages).toEqual([{ ...before[0], body: "Hello, world" }, before[1]])
    // A body is posted too: an update on a message that has one must extend it.
    const posted = build([post("m1", "one", "run"), write("m1", "one two")])
    expect(posted.state.chat.messages[0]).toMatchObject({ body: "one two", status: "posted", hubSeq: 1 })
  })

  it("answers a repeated or a late body with no event: a crashed run resends what it has", () => {
    const shard = build([answer, write("a1", "Hello, wor")])
    expect(reasonOf(shard.state, write("a1", "Hello, wor"))).toBe("accepted:0")
    expect(reasonOf(shard.state, write("a1", "Hel"))).toBe("accepted:0")
    expect(reasonOf(shard.state, write("a1", ""))).toBe("accepted:0")
    expect(reasonOf(shard.state, write("a1", "Hello, world"))).toBe("accepted:1")
    // As a key's first submit, the no-op takes a receipt and no hubSeq.
    const again = submit(shard, { epoch: 0, origin: "t", commandId: "late", command: write("a1", "Hel") })
    expect(again.result).toEqual({ _tag: "Accepted", firstSeq: 3, count: 0 })
    expect(again.state.headSeq).toBe(2)
    expect(again.state.state).toBe(shard.state)
  })

  it("refuses a body that does not extend the stored one", () => {
    const shard = build([answer, write("a1", "Hello")])
    expect(reasonOf(shard.state, write("a1", "Help"))).toBe("body_conflict")
    expect(reasonOf(shard.state, write("a1", "hello, world"))).toBe("body_conflict")
    expect(reasonOf(shard.state, write("a1", "Hell!"))).toBe("body_conflict")
    expect(reasonOf(shard.state, write("nope", "Hello"))).toBe("message_missing")
  })

  it("lets only the message's own author extend it", () => {
    const shard = build([answer, write("a1", "Hello")])
    expect(reasonOf(shard.state, write("a1", "Hello, world", "another-run"))).toBe("body_author")
    expect(reasonOf(shard.state, write("a1", "Hello, world", "will"))).toBe("body_author")
    // Not even to say what it already says: a stranger learns nothing of the body from the answer.
    expect(reasonOf(shard.state, write("a1", "Hello", "another-run"))).toBe("body_author")
    expect(reasonOf(shard.state, write("a1", "", ""))).toBe("body_author")
  })

  it("never rewrites a question, whoever asks and whatever the body", () => {
    const question: Post = { _tag: "PostMessage", messageId: "q1", author: "will", body: "Why?", role: "user" }
    const shard = build([question, answer])
    expect(reasonOf(shard.state, write("q1", "Why? Because.", "will"))).toBe("body_question")
    expect(reasonOf(shard.state, write("q1", "Why? Because.", "run"))).toBe("body_question")
    // The same body, a shorter one and an empty one are refused too: a question takes no body command at all.
    expect(reasonOf(shard.state, write("q1", "Why?", "will"))).toBe("body_question")
    expect(reasonOf(shard.state, write("q1", "", "will"))).toBe("body_question")
    const streaming = build([question, status("q1", "streaming")])
    expect(reasonOf(streaming.state, write("q1", "Why? Because.", "will"))).toBe("body_question")
    // A message with no role, or an answer's, is its author's to extend.
    expect(reasonOf(build([post("m1", "one")]).state, write("m1", "one two", "will"))).toBe("accepted:1")
  })

  it("freezes the body once the status is terminal", () => {
    for (const end of ["complete", "failed"] as const) {
      const shard = build([answer, status("a1", "streaming"), write("a1", "Hello"), status("a1", end)])
      expect(reasonOf(shard.state, write("a1", "Hello, world"))).toBe("terminal_body")
      // A body that diverges is refused as late, not as a conflict: a finished message takes nothing.
      expect(reasonOf(shard.state, write("a1", "Other"))).toBe("terminal_body")
      // What it holds, and what it held on the way, is still answered as landed.
      expect(reasonOf(shard.state, write("a1", "Hello"))).toBe("accepted:0")
      expect(reasonOf(shard.state, write("a1", "He"))).toBe("accepted:0")
      expect(reasonOf(shard.state, write("a1", "Hello, world", "another-run"))).toBe("body_author")
      expect(shard.state.chat.messages[0]).toMatchObject({ body: "Hello", status: end })
    }
  })

  it("rebases an optimistic body update, and a post that repeats the grown body", () => {
    const shard = build([answer])
    const rebased = rebasePending(shard.state, [write("a1", "Hel"), write("a1", "Hello"), write("a1", "Nope")])
    expect(rebased.decisions.map((decision) => decision._tag === "Accepted" ? decision.events.length : decision.reason))
      .toEqual([1, 1, "body_conflict"])
    expect(rebased.state.chat.messages[0]).toMatchObject({ body: "Hello", hubSeq: 1 })
    // A post names the body the message was born with: once the body has grown, only the grown body agrees.
    expect(reasonOf(rebased.state, answer)).toBe("message_conflict")
    expect(reasonOf(rebased.state, { ...answer, body: "Hello" })).toBe("accepted:0")
  })

  it("bounds a streamed body at the wire and refuses a lone surrogate, on the command and the event alike", () => {
    const decodeCommand = Schema.decodeUnknownExit(CommandSchema)
    const decodeEnvelope = Schema.decodeUnknownExit(ShardState)
    expect(MAX_BODY_LENGTH).toBe(32_000)
    const logged = (body: string) => ({
      ...initialShardState,
      log: [{ hubSeq: 1, epoch: 0, origin: "t", commandId: "c", event: { _tag: "MessageBodyUpdated", id: "a1", body } }]
    })
    const pair = "\u{1F600}"
    const fits = ["", "x".repeat(MAX_BODY_LENGTH), pair, `a${pair}b`, pair.repeat(MAX_BODY_LENGTH / 2)]
    for (const body of fits) {
      expect(decodeCommand(write("a1", body))._tag, `${body.length} units`).toBe("Success")
      expect(decodeEnvelope(logged(body))._tag, `${body.length} units`).toBe("Success")
    }
    const refused = ["x".repeat(MAX_BODY_LENGTH + 1), "\uD83D", "\uDE00", "a\uD83Db", "\uDE00\uD83D", `${pair}\uD83D`]
    for (const body of refused) {
      expect(decodeCommand(write("a1", body))._tag, `${body.length} units`).toBe("Failure")
      expect(decodeEnvelope(logged(body))._tag, `${body.length} units`).toBe("Failure")
    }
    expect(decodeCommand({ _tag: "UpdateMessageBody", messageId: "a1", body: "x" })._tag).toBe("Failure")
    expect(decodeCommand({ _tag: "UpdateMessageBody", messageId: "a1", author: "run" })._tag).toBe("Failure")
    expect(Schema.decodeUnknownSync(CommandSchema)({ ...write("a1", "x"), status: "complete", smuggled: 1 }))
      .toEqual(write("a1", "x"))
  })

  it("bounds a post's body as a body update's: its length, and no lone surrogate", () => {
    const decodeCommand = Schema.decodeUnknownExit(CommandSchema)
    const pair = "\u{1F600}"
    for (const body of ["", "x".repeat(MAX_BODY_LENGTH), pair, `a${pair}b`, pair.repeat(MAX_BODY_LENGTH / 2)]) {
      expect(decodeCommand(post("m1", body))._tag, `${body.length} units`).toBe("Success")
    }
    for (const body of ["x".repeat(MAX_BODY_LENGTH + 1), "\uD83D", "\uDE00", "a\uD83Db", "\uDE00\uD83D", `${pair}\uD83D`]) {
      expect(decodeCommand(post("m1", body))._tag, `${body.length} units`).toBe("Failure")
    }
    // A message and a posted event written before the bound keep the body they hold: an old journal still decodes.
    const old = "\uD83D" + "x".repeat(MAX_BODY_LENGTH)
    const shard = {
      ...initialShardState,
      headSeq: 1,
      state: { plan: { revision: 0, nodes: {} }, chat: { messages: [{ id: "m1", author: "will", body: old, status: "posted", hubSeq: 1 }] } },
      log: [{ hubSeq: 1, epoch: 0, origin: "t", commandId: "c", event: { _tag: "MessagePosted", id: "m1", author: "will", body: old } }]
    }
    expect(Schema.decodeUnknownSync(ShardState)(JSON.parse(JSON.stringify(shard))).state.chat.messages[0]!.body).toBe(old)
  })

  it("keeps the view a question was sent from, and its values, as the post said them and never after", () => {
    const source = { viewId: "0b5a2f52-58a1-4b8f-9d2b-5a2c7d3f4e10", event: "submit" } as const
    const data = JSON.stringify({ plan: "pro", seats: 3, yearly: true })
    const question: Post = { _tag: "PostMessage", messageId: "q1", author: "will", body: "Upgrade", role: "user", position: 4, source, data }
    const shard = build([question])
    expect(shard.state.chat.messages[0]).toEqual({
      id: "q1", author: "will", body: "Upgrade", status: "posted", hubSeq: 1, role: "user", position: 4, source, data
    })
    expect(shard.log[0]!.event).toEqual({ _tag: "MessagePosted", id: "q1", author: "will", body: "Upgrade", role: "user", position: 4, source, data })
    // The message holds its own copy: changing the command's source afterwards changes nothing.
    expect(shard.state.chat.messages[0]!.source).not.toBe(source)
    expect(reasonOf(shard.state, question)).toBe("accepted:0")
    // The origin is compared whole: another view, another event, other values, or none of them is a conflict.
    expect(reasonOf(shard.state, { ...question, source: { ...source, event: "pick" } })).toBe("message_conflict")
    expect(reasonOf(shard.state, { ...question, source: { ...source, viewId: "other" } })).toBe("message_conflict")
    expect(reasonOf(shard.state, { ...question, data: "{}" })).toBe("message_conflict")
    const { source: _, data: __, ...bare } = question
    expect(reasonOf(shard.state, bare)).toBe("message_conflict")
    expect(reasonOf(build([bare]).state, question)).toBe("message_conflict")
    // No later command names them: a metadata patch that carries them is decoded without them.
    const patched = Schema.decodeUnknownSync(CommandSchema)({ ...meta("q1", { summary: "Upgrade" }), source, data: "{}" })
    expect(patched).toEqual(meta("q1", { summary: "Upgrade" }))
    const after = build([question, patched, status("q1", "complete")])
    expect(after.state.chat.messages[0]).toMatchObject({ source, data, position: 4, summary: "Upgrade", status: "complete" })
  })

  it("bounds a source and its data at the wire", () => {
    const decodeCommand = Schema.decodeUnknownExit(CommandSchema)
    const sourced = (fields: object) => ({ _tag: "PostMessage", messageId: "q1", author: "will", body: "Hi", role: "user", ...fields })
    expect(MAX_DATA_LENGTH).toBe(16_384)
    const label = "v".repeat(MAX_LABEL_LENGTH)
    for (const fields of [
      { source: { viewId: label, event: label } },
      { source: { viewId: "v", event: "e" }, data: "x".repeat(MAX_DATA_LENGTH) },
      { data: "\u{1F600}" },
      {}
    ]) expect(decodeCommand(sourced(fields))._tag, JSON.stringify(fields).slice(0, 40)).toBe("Success")
    for (const fields of [
      { source: { viewId: `${label}v`, event: "e" } },
      { source: { viewId: "v", event: `${label}e` } },
      { source: { viewId: "v" } },
      { source: { event: "e" } },
      { source: "view" },
      { source: { viewId: "\uD83D", event: "e" } },
      { source: { viewId: "v", event: "\uDE00" } },
      { data: "x".repeat(MAX_DATA_LENGTH + 1) },
      { data: "\uD83D" },
      { data: { plan: "pro" } }
    ]) expect(decodeCommand(sourced(fields))._tag, JSON.stringify(fields).slice(0, 40)).toBe("Failure")
    // Whatever else a source carries is not kept.
    expect(Schema.decodeUnknownSync(CommandSchema)(sourced({ source: { viewId: "v", event: "e", person: "ada" } })))
      .toEqual(sourced({ source: { viewId: "v", event: "e" } }))
  })

  /** The ids of a shard's messages in reading order: by place, and among equal places in the order the chat holds. */
  const reading = (shard: ShardState): ReadonlyArray<string> => {
    const places = placesOf(shard.state.chat.messages)
    return shard.state.chat.messages.map((message, index) => ({ id: message.id, place: places[index]!, index }))
      .sort((left, right) => left.place - right.place || left.index - right.index).map(({ id }) => id)
  }
  const QUESTION = questionOwner("q1")
  const ANSWER = answerOwner("a1")
  const extend = (body: string): Command => ({ _tag: "UpdateMessageBody", messageId: "a1", author: ANSWER, body })

  it("reads a bridged answer posted before its question after it, and moves nothing when the question arrives", () => {
    const answered: Post = { _tag: "PostMessage", messageId: "a1", author: ANSWER, body: "", role: "assistant", questionId: "q1", position: 5 }
    const asked: Post = { _tag: "PostMessage", messageId: "q1", author: QUESTION, body: "Why?", role: "user", position: 4 }
    const early = build([answered])
    expect(early.state.chat.messages.map((message) => message.id)).toEqual(["a1"])
    expect(placesOf(early.state.chat.messages)).toEqual([5])
    const late = build([answered, extend("Because."), status("a1", "complete"), asked])
    const [answer, question] = late.state.chat.messages
    // The answer is exactly what it was before the question arrived, and each reads at the position its post gave.
    expect(answer).toEqual(build([answered, extend("Because."), status("a1", "complete")]).state.chat.messages[0])
    expect(question).toMatchObject({ id: "q1", hubSeq: 4, position: 4 })
    expect(placesOf(late.state.chat.messages)).toEqual([5, 4])
    expect(reading(late)).toEqual(["q1", "a1"])
    // The same two posts in the other order hold the same origins.
    const inOrder = build([asked, answered])
    expect(inOrder.state.chat.messages.map(originOf)).toEqual([question, answer].map((message) => originOf(message!)))
  })

  it("places a message only by the bridge's position: anyone else's is ignored, and their post never reads before what was there", () => {
    const asked: Post = { _tag: "PostMessage", messageId: "q1", author: QUESTION, body: "Why?", role: "user", position: 40 }
    const answered: Post = { _tag: "PostMessage", messageId: "a1", author: ANSWER, body: "", role: "assistant", questionId: "q1", position: 41 }
    // A direct writer names the very first place, a time before the exchange and the question it would follow.
    const backdated: Post = {
      _tag: "PostMessage", messageId: "d1", author: "person:direct", body: "First!", role: "user", position: 0,
      createdAt: "2000-01-01T00:00:00Z"
    }
    const squatted: Post = {
      _tag: "PostMessage", messageId: "d2", author: "agent:direct", body: "Mine", role: "assistant", questionId: "q1"
    }
    const shard = build([asked, answered, backdated, squatted])
    expect(shard.state.chat.messages.map(isBridged)).toEqual([true, true, false, false])
    // The position is stored as the post said it, and is no one's place: both read after the exchange, in the order
    // the shard sequenced them.
    expect(shard.state.chat.messages[2]).toMatchObject({ position: 0 })
    expect(placesOf(shard.state.chat.messages)).toEqual([40, 41, 42, 43])
    expect(reading(shard)).toEqual(["q1", "a1", "d1", "d2"])
    // A later exchange Postgres places at the same number still reads after the direct post that was there.
    const next: Post = { _tag: "PostMessage", messageId: "q2", author: questionOwner("q2"), body: "And?", role: "user", position: 42 }
    expect(reading(build([asked, answered, backdated, squatted, next]))).toEqual(["q1", "a1", "d1", "q2", "d2"])
    // Only the bridge's owner name for the message's own id counts: another message's owner name places nothing.
    const borrowed: Post = { _tag: "PostMessage", messageId: "d3", author: QUESTION, body: "Borrowed", role: "user", position: 0 }
    expect(placesOf(build([asked, answered, borrowed]).state.chat.messages)).toEqual([40, 41, 42])
    // In an empty shard a direct post is anchored where the shard sequenced it.
    expect(placesOf(build([upsert("n", null), backdated]).state.chat.messages)).toEqual([2])
  })

  it("moves one message only: an answer an earlier bridge posted with no position, to straight after its question, past a row in between", () => {
    const legacy: Post = { _tag: "PostMessage", messageId: "a1", author: ANSWER, body: "", role: "assistant", questionId: "q1" }
    const between: Post = { _tag: "PostMessage", messageId: "d1", author: "person:direct", body: "Between", position: 0 }
    const asked: Post = { _tag: "PostMessage", messageId: "q1", author: QUESTION, body: "Why?", role: "user", position: 40 }
    const before = build([legacy, between])
    expect(placesOf(before.state.chat.messages)).toEqual([1, 2])
    expect(reading(before)).toEqual(["a1", "d1"])
    // The question arrives with its position: the answer reads one past it, and the row in between stays where it was.
    const after = build([legacy, between, asked])
    expect(placesOf(after.state.chat.messages)).toEqual([41, 2, 40])
    expect(reading(after)).toEqual(["d1", "q1", "a1"])
    // Nothing moves for a question that is not the bridge's, one with no position, or an answer that is not the bridge's.
    const unplaced: Post = { _tag: "PostMessage", messageId: "q1", author: QUESTION, body: "Why?", role: "user" }
    expect(placesOf(build([legacy, between, unplaced]).state.chat.messages)).toEqual([1, 2, 3])
    const strangers: Post = { ...asked, author: "person:direct" }
    expect(placesOf(build([legacy, between, strangers]).state.chat.messages)).toEqual([1, 2, 3])
    const direct: Post = { ...legacy, author: "agent:direct" }
    expect(placesOf(build([direct, between, asked]).state.chat.messages)).toEqual([1, 2, 40])
    // A legacy answer that names no question stays at its anchor.
    const { questionId: _, ...alone } = legacy
    expect(placesOf(build([alone, asked]).state.chat.messages)).toEqual([1, 40])
  })

  it("admits a position up to 2 ** 50 and no higher, so every place adds exactly", () => {
    expect(MAX_ADMITTED_POSITION).toBe(1125899906842624)
    const direct: Post = { _tag: "PostMessage", messageId: "d1", author: "person:direct", body: "After" }
    const at = (position: number): Post => ({ _tag: "PostMessage", messageId: "q1", author: QUESTION, body: "Why?", role: "user", position })
    // The ceiling is a place, and the floor two past it is exact.
    expect(placeOf({ position: MAX_ADMITTED_POSITION })).toBe(MAX_ADMITTED_POSITION)
    expect(placesOf(build([at(MAX_ADMITTED_POSITION), direct]).state.chat.messages)).toEqual([MAX_ADMITTED_POSITION, MAX_ADMITTED_POSITION + 2])
    // One past it, and the largest integer a double holds, are no position: the question is anchored where the shard
    // sequenced it, reserves nothing, and the next row is one past it, as Lean's `Nat` has it.
    for (const position of [MAX_ADMITTED_POSITION + 1, Number.MAX_SAFE_INTEGER]) {
      expect(placeOf({ position })).toBeUndefined()
      expect(placesOf(build([at(position), direct]).state.chat.messages)).toEqual([1, 2])
    }
    expect(placeOf({})).toBeUndefined()
    // An answer posted with a position past the ceiling is unplaced: it reads straight after its placed question.
    const answered: Post = {
      _tag: "PostMessage", messageId: "a1", author: ANSWER, body: "", role: "assistant", questionId: "q1",
      position: Number.MAX_SAFE_INTEGER
    }
    expect(placesOf(build([answered, at(40)]).state.chat.messages)).toEqual([41, 40])
    // A question past the ceiling gives its unplaced answer nowhere to move to.
    const { position: _, ...unplaced } = answered
    expect(placesOf(build([unplaced, at(Number.MAX_SAFE_INTEGER)]).state.chat.messages)).toEqual([1, 2])
  })

  it("ignores a delayed older note: a patch no newer than the stored version changes nothing", () => {
    const note = (
      noteVersion: number | undefined,
      summary: string,
      phase?: string
    ): Extract<Command, { _tag: "UpdateMessageMetadata" }> => ({
      _tag: "UpdateMessageMetadata",
      messageId: "m1",
      summary,
      ...(phase === undefined ? {} : { phase }),
      ...(noteVersion === undefined ? {} : { noteVersion })
    })
    const newer = build([post("m1", "one"), status("m1", "complete"), note(2, "second", "{\"title\":\"b\"}")])
    expect(newer.state.chat.messages[0]).toMatchObject({ summary: "second", noteVersion: 2 })
    // The write before it, arriving after it: accepted with no event, and the newer note stands whole.
    for (const stale of [note(1, "first", "{\"title\":\"a\"}"), note(2, "second again")]) {
      const decision = decide(newer.state, stale)
      expect(decision).toEqual({ _tag: "Accepted", events: [] })
      const { state, result } = submit(newer, { epoch: 0, origin: "t", commandId: "late-" + stale.summary, command: stale })
      expect(result._tag).toBe("Accepted")
      expect(state.state).toEqual(newer.state)
      expect(state.log).toEqual(newer.log)
    }
    // A newer write replaces it, and a patch that names no version is the author's own and still applies.
    expect(build([post("m1", "one"), note(2, "second"), note(3, "third")]).state.chat.messages[0])
      .toMatchObject({ summary: "third", noteVersion: 3 })
    expect(build([post("m1", "one"), note(2, "second"), note(undefined, "plain")]).state.chat.messages[0])
      .toMatchObject({ summary: "plain", noteVersion: 2 })
    // A first versioned write lands on notes that had none, version 0 included.
    expect(build([post("m1", "one"), note(undefined, "plain"), note(0, "zero")]).state.chat.messages[0])
      .toMatchObject({ summary: "zero", noteVersion: 0 })
    // A stale patch that would also change a finished message's run is refused as any such patch is.
    expect(reasonOf(newer.state, { ...note(1, "first"), modelId: "m-large" })).toBe("terminal_metadata")
    // The version is a count: nothing negative or fractional decodes.
    for (const value of [-1, 1.5]) {
      expect(Schema.decodeUnknownExit(CommandSchema)(note(value, "bad"))._tag).toBe("Failure")
    }
  })
})

describe("sync envelope", () => {
  const envelope = (commandId: string, command: Command, epoch = 0, origin = "node-a") => ({
    epoch,
    origin,
    commandId,
    command
  })

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
    const [one, two, three] = shard.log as [
      typeof shard.log[number],
      typeof shard.log[number],
      typeof shard.log[number]
    ]
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
    expect(evolve(initialAppState, shard.log[0]!)).toEqual(
      replayed.chat.messages.length === 1 ? { ...replayed, chat: { messages: [] } } : replayed
    )
  })
})
