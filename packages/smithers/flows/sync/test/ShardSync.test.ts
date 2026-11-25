/**
 * Protocol v2 end to end: `ShardServer` sequencing commands from
 * `ShardClient`s over an in-process transport, including lost responses,
 * epoch fencing, compaction and a node that restarts from its persisted
 * cursor.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as fc from "fast-check"
import { ShardClient, ShardProtocol, ShardServer } from "../src/index.ts"

const shard = "repo:acme/widgets" as ShardProtocol.ShardId
const stream = "repo:acme/widgets" as ShardProtocol.StreamId

const command = (node: string, id: string, payload: Schema.Json): ShardProtocol.Command => ({
  key: [node, id],
  stream,
  payload
})

const submit = (server: ShardServer.ShardServer, cmd: ShardProtocol.Command, epoch = 0) =>
  server.submit({ version: 2, shard, epoch, command: cmd })

const pull = (server: ShardServer.ShardServer, after: number, limit = 100, epoch = 0) =>
  server.pull({ version: 2, shard, epoch, after, limit })

/** A projection that records what it was handed, as a node's local SQLite would apply it. */
const projection = () => {
  const deliveries: Array<ShardClient.Delivery> = []
  let rows: Array<Schema.Json> = []
  return {
    deliveries,
    rows: () => rows,
    apply: (delivery: ShardClient.Delivery) =>
      Effect.sync(() => {
        deliveries.push(delivery)
        if (delivery._tag === "Reset") {
          rows = delivery.snapshot.state === null
            ? []
            : [...(delivery.snapshot.state as Array<Schema.Json>)]
        } else for (const entry of delivery.entries) rows.push(...entry.events)
      })
  }
}

describe("ShardProtocol", () => {
  it("accepts every stream kind and refuses an unknown or empty one", () => {
    const decode = Schema.decodeUnknownExit(ShardProtocol.StreamId)
    for (const kind of ShardProtocol.streamKinds) expect(Exit.isSuccess(decode(`${kind}:x`))).toBe(true)
    expect(Exit.isFailure(decode("branch:x"))).toBe(true)
    expect(Exit.isFailure(decode("repo:"))).toBe(true)
    expect(ShardProtocol.streamKind("repo-maint:acme/w" as ShardProtocol.StreamId)).toBe("repo-maint")
    expect(ShardProtocol.streamKind("github:acme/w:pr:1" as ShardProtocol.StreamId)).toBe("github")
  })

  it.effect("carries a pull request in a GET query string and refuses a malformed one", () =>
    Effect.gen(function*() {
      const request = { version: 2 as const, shard, epoch: 3, after: 41, limit: 50 }
      const query = ShardProtocol.pullQuery(request)
      expect(query.toString()).toBe("v=2&shard=repo%3Aacme%2Fwidgets&epoch=3&after=41&limit=50")
      expect(yield* ShardProtocol.decodePullQuery(new URLSearchParams(query.toString()))).toEqual(request)
      const missing = new URLSearchParams(query)
      missing.delete("after")
      expect(Exit.isFailure(yield* Effect.exit(ShardProtocol.decodePullQuery(missing)))).toBe(true)
      const badVersion = new URLSearchParams(query)
      badVersion.set("v", "1")
      expect(Exit.isFailure(yield* Effect.exit(ShardProtocol.decodePullQuery(badVersion)))).toBe(true)
    }))

  it.effect("binds a key to content, whatever the key order", () =>
    Effect.gen(function*() {
      expect(ShardProtocol.canonicalJson({ b: [1, { d: null, c: "x" }], a: true })).toBe(
        "{\"a\":true,\"b\":[1,{\"c\":\"x\",\"d\":null}]}"
      )
      const one = yield* ShardProtocol.contentHash(command("n", "1", { a: 1, b: 2 }))
      expect(yield* ShardProtocol.contentHash(command("other", "9", { b: 2, a: 1 }))).toBe(one)
      expect(yield* ShardProtocol.contentHash(command("n", "1", { a: 1, b: 3 }))).not.toBe(one)
      expect(one).toMatch(/^[0-9a-f]{64}$/)
    }))
})

describe("ShardServer", () => {
  it.effect("sequences gapless and answers a retry from its receipt", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      const first = yield* submit(server, command("a", "1", "one"))
      const second = yield* submit(server, command("b", "1", "two"))
      expect(first).toEqual({ _tag: "Accepted", key: ["a", "1"], position: { shard, epoch: 0, seq: 1 } })
      expect(second).toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
      expect(yield* submit(server, command("a", "1", "one"))).toEqual({ ...first, _tag: "Duplicate" })
      expect(yield* submit(server, command("a", "1", "changed"))).toEqual({
        _tag: "IdempotencyConflict",
        shard,
        key: ["a", "1"],
        position: { shard, epoch: 0, seq: 1 }
      })
      expect(yield* server.head).toEqual({ shard, epoch: 0, seq: 2 })
      const page = yield* pull(server, 0)
      expect(page).toMatchObject({ _tag: "Page", through: 2, head: 2, done: true })
      expect(page).toMatchObject({ entries: [{ seq: 1 }, { seq: 2 }] })
    }))

  it.effect("keeps a refusal as the key's receipt", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({
        shard,
        store: ShardServer.memoryStore(),
        decide: (cmd) =>
          cmd.payload === "bad"
            ? { _tag: "Refused", reason: "bad payload" }
            : { _tag: "Accepted", events: ["ok", cmd.payload] }
      })
      expect(yield* submit(server, command("a", "1", "bad"))).toEqual({
        _tag: "Refused",
        shard,
        key: ["a", "1"],
        reason: "bad payload"
      })
      expect(yield* submit(server, command("a", "1", "bad"))).toEqual({
        _tag: "Refused",
        shard,
        key: ["a", "1"],
        reason: "bad payload"
      })
      expect(yield* submit(server, command("a", "1", "good"))).toEqual({
        _tag: "IdempotencyConflict",
        shard,
        key: ["a", "1"],
        position: null
      })
      yield* submit(server, command("a", "2", "good"))
      expect(yield* pull(server, 0)).toMatchObject({ entries: [{ seq: 1, events: ["ok", "good"] }] })
    }))

  it.effect("rolls back everything a failing decision wrote", () =>
    Effect.gen(function*() {
      let explode = true
      const server = ShardServer.make({
        shard,
        decide: (cmd) => {
          if (explode && cmd.payload === "boom") throw new Error("decision fault")
          return { _tag: "Accepted", events: [cmd.payload] }
        }
      })
      yield* submit(server, command("a", "1", "fine"))
      const failed = yield* Effect.exit(submit(server, command("a", "2", "boom")))
      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* server.head).toMatchObject({ seq: 1 })
      explode = false
      expect(yield* submit(server, command("a", "2", "boom"))).toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
    }))

  it.effect("fences writers and readers under an old epoch", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      yield* submit(server, command("a", "1", "one"))
      expect(yield* server.advanceEpoch).toEqual({ shard, epoch: 1, seq: 1 })
      expect(yield* submit(server, command("a", "2", "two"))).toEqual({
        _tag: "StaleEpoch",
        key: ["a", "2"],
        shard,
        epoch: 1
      })
      expect(yield* pull(server, 1)).toEqual({ _tag: "Resync", shard, epoch: 1, snapshotSeq: 0 })
      expect(yield* submit(server, command("a", "2", "two"), 1)).toMatchObject({
        _tag: "Accepted",
        position: { epoch: 1, seq: 2 }
      })
      // A key accepted under the old epoch keeps the position it was given.
      expect(yield* submit(server, command("a", "1", "one"), 1)).toMatchObject({
        _tag: "Duplicate",
        position: { epoch: 0, seq: 1 }
      })
    }))

  it.effect("pages by limit and resyncs a cursor outside retained history", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      for (const id of ["1", "2", "3", "4", "5"]) yield* submit(server, command("a", id, Number(id)))
      expect(yield* pull(server, 1, 2)).toMatchObject({ through: 3, head: 5, done: false })
      expect(yield* pull(server, 5, 2)).toMatchObject({ entries: [], through: 5, done: true })
      expect(yield* pull(server, 6)).toEqual({ _tag: "Resync", shard, epoch: 0, snapshotSeq: 0 })
      expect(yield* server.compact(3, [1, 2, 3])).toEqual({ shard, epoch: 0, seq: 3 })
      expect(yield* pull(server, 2)).toEqual({ _tag: "Resync", shard, epoch: 0, snapshotSeq: 3 })
      expect(yield* server.snapshot(shard)).toEqual({ position: { shard, epoch: 0, seq: 3 }, state: [1, 2, 3] })
      expect(yield* pull(server, 3)).toMatchObject({ entries: [{ seq: 4 }, { seq: 5 }] })
      for (const seq of [2, 6]) {
        expect(yield* Effect.flip(server.compact(seq, null))).toMatchObject({ reason: "out_of_range" })
      }
    }))

  it.effect("refuses a request for another shard", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      const other = "repo:other" as ShardProtocol.ShardId
      const errors = [
        yield* Effect.flip(server.submit({ version: 2, shard: other, epoch: 0, command: command("a", "1", 1) })),
        yield* Effect.flip(server.pull({ version: 2, shard: other, epoch: 0, after: 0, limit: 1 })),
        yield* Effect.flip(server.snapshot(other))
      ]
      for (const error of errors) {
        expect(error).toBeInstanceOf(ShardProtocol.ShardError)
        expect(error.reason).toBe("wrong_shard")
      }
    }))
})

describe("ShardClient", () => {
  it.effect("pushes the outbox, pulls the order, and converges two nodes", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      const a = projection()
      const b = projection()
      const nodeA = yield* ShardClient.make({
        shard,
        node: "a",
        transport: server,
        store: ShardClient.memoryStore(),
        apply: a.apply
      })
      const nodeB = yield* ShardClient.make({
        shard,
        node: "b",
        transport: server,
        store: ShardClient.memoryStore(),
        apply: b.apply,
        limit: 1
      })
      expect(yield* nodeA.enqueue(stream, "a1")).toEqual({ key: ["a", "0"], stream, payload: "a1" })
      yield* nodeA.enqueue(stream, "a2")
      yield* nodeB.enqueue(stream, "b1")
      expect((yield* nodeA.push).map((answer) => answer._tag)).toEqual(["Accepted", "Accepted"])
      expect(yield* nodeB.sync).toEqual({ shard, epoch: 0, seq: 3 })
      expect(yield* nodeA.pull).toEqual({ shard, epoch: 0, seq: 3 })
      expect(a.rows()).toEqual(["a1", "a2", "b1"])
      expect(b.rows()).toEqual(a.rows())
      // Up to date: an empty page moves nothing and applies nothing.
      const before = a.deliveries.length
      expect(yield* nodeA.pull).toEqual({ shard, epoch: 0, seq: 3 })
      expect(a.deliveries.length).toBe(before)
      expect(yield* nodeA.state).toEqual({ epoch: 0, applied: 3, nextCommand: 2, outbox: [] })
    }))

  it.effect("retries a command whose answer was lost, without a second entry", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      let drop = true
      const lossy: ShardClient.Transport = {
        ...server,
        // The shard sequences the command; its answer never arrives.
        submit: (request) =>
          Effect.flatMap(server.submit(request), (answer) => {
            if (!drop) return Effect.succeed(answer)
            drop = false
            return Effect.die("connection reset")
          })
      }
      const store = ShardClient.memoryStore()
      const node = yield* ShardClient.make({ shard, node: "a", transport: lossy, store, apply: () => Effect.void })
      yield* node.enqueue(stream, "once")
      expect(Exit.isFailure(yield* Effect.exit(node.push))).toBe(true)
      expect((yield* store.load).outbox).toHaveLength(1)
      // The node restarts with its disk intact and pushes again.
      const restarted = yield* ShardClient.make({ shard, node: "a", transport: lossy, store, apply: () => Effect.void })
      expect(yield* restarted.push).toEqual([{
        _tag: "Duplicate",
        key: ["a", "0"],
        position: { shard, epoch: 0, seq: 1 }
      }])
      expect(yield* server.head).toMatchObject({ seq: 1 })
    }))

  it.effect("resubmits under the shard's new epoch and resyncs from its snapshot", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      const view = projection()
      const node = yield* ShardClient.make({
        shard,
        node: "a",
        transport: server,
        store: ShardClient.memoryStore(),
        apply: view.apply
      })
      yield* node.enqueue(stream, 1)
      yield* node.sync
      yield* server.advanceEpoch
      yield* node.enqueue(stream, 2)
      expect(yield* node.push).toEqual([{ _tag: "Accepted", key: ["a", "1"], position: { shard, epoch: 1, seq: 2 } }])
      // Its cursor was read under epoch 0, so the pull resets to the snapshot (none yet) and replays.
      expect(yield* node.pull).toEqual({ shard, epoch: 1, seq: 2 })
      expect(view.deliveries.map((delivery) => delivery._tag)).toEqual(["Entries", "Reset", "Entries"])
      expect(view.rows()).toEqual([1, 2])
      // After compaction, a node far behind starts from the folded state.
      yield* server.compact(2, [1, 2])
      const late = projection()
      const fresh = yield* ShardClient.make({
        shard,
        node: "c",
        transport: server,
        store: ShardClient.memoryStore(),
        apply: late.apply
      })
      expect(yield* fresh.pull).toEqual({ shard, epoch: 1, seq: 2 })
      expect(late.rows()).toEqual([1, 2])
    }))

  it.effect("resumes from its persisted cursor after a restart", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      for (const id of ["1", "2", "3"]) yield* submit(server, command("w", id, Number(id)))
      const requests: Array<number> = []
      const watched: ShardClient.Transport = {
        ...server,
        pull: (request) => Effect.andThen(Effect.sync(() => requests.push(request.after)), server.pull(request))
      }
      const store = ShardClient.memoryStore()
      const first = projection()
      yield* (yield* ShardClient.make({ shard, node: "r", transport: watched, store, apply: first.apply })).pull
      for (const id of ["4", "5"]) yield* submit(server, command("w", id, Number(id)))
      const second = projection()
      const reopened = yield* ShardClient.make({ shard, node: "r", transport: watched, store, apply: second.apply })
      expect(yield* reopened.pull).toEqual({ shard, epoch: 0, seq: 5 })
      expect(requests).toEqual([0, 3])
      expect(second.rows()).toEqual([4, 5])
    }))

  it.effect("converges every node with zero duplicate entries under duplicate delivery", () =>
    Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({ node: fc.constantFrom("a", "b", "c"), id: fc.integer({ min: 0, max: 5 }), resend: fc.nat(3) }),
            {
              maxLength: 30
            }
          ),
          async (trace) => {
            const server = ShardServer.make({ shard })
            for (const step of trace) {
              for (let i = 0; i <= step.resend; i++) {
                await Effect.runPromise(submit(server, command(step.node, String(step.id), `${step.node}:${step.id}`)))
              }
            }
            const unique = new Set(trace.map((step) => `${step.node}:${step.id}`))
            const views = [projection(), projection()]
            for (const [index, view] of views.entries()) {
              const node = await Effect.runPromise(
                ShardClient.make({
                  shard,
                  node: `r${index}`,
                  transport: server,
                  store: ShardClient.memoryStore(),
                  apply: view.apply,
                  limit: 4
                })
              )
              await Effect.runPromise(node.pull)
            }
            expect(views[0]!.rows()).toHaveLength(unique.size)
            expect(new Set(views[0]!.rows()).size).toBe(unique.size)
            expect(views[1]!.rows()).toEqual(views[0]!.rows())
          }
        ),
        { numRuns: 100 }
      )
    ))
})

// Regressions for the Codex Astra review of W2-C: each test fails on the code the review read.
describe("ShardClient review regressions", () => {
  it.effect("H2: an enqueue interrupted after its durable write never reuses its command id", () =>
    Effect.gen(function*() {
      const disk = ShardClient.memoryStore()
      const written = yield* Deferred.make<void>()
      const acknowledge = yield* Deferred.make<void>()
      let slow = true
      // The write is durable before the store acknowledges it; the client is interrupted in between.
      const store: ShardClient.ClientStore = {
        load: disk.load,
        modify: (f) =>
          Effect.tap(disk.modify(f), () =>
            slow ? Effect.andThen(Deferred.succeed(written, void 0), Deferred.await(acknowledge)) : Effect.void)
      }
      const server = ShardServer.make({ shard })
      const node = yield* ShardClient.make({ shard, node: "a", transport: server, store, apply: () => Effect.void })
      const first = yield* Effect.forkChild(node.enqueue(stream, "first"))
      yield* Deferred.await(written)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(first))
      yield* Deferred.succeed(acknowledge, void 0)
      yield* Fiber.join(interrupting)
      slow = false
      expect(yield* node.enqueue(stream, "second")).toEqual({ key: ["a", "1"], stream, payload: "second" })
      expect((yield* node.state).outbox.map((cmd) => cmd.payload)).toEqual(["first", "second"])
      expect((yield* node.push).map((answer) => answer._tag)).toEqual(["Accepted", "Accepted"])
      const page = yield* pull(server, 0)
      expect(page).toMatchObject({ entries: [{ events: ["first"] }, { events: ["second"] }] })
    }))

  it.effect("H3: two clients for one node and store never take the same command id", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      const store = ShardClient.memoryStore()
      const open = () => ShardClient.make({ shard, node: "a", transport: server, store, apply: () => Effect.void })
      const [one, two] = [yield* open(), yield* open()]
      const commands = yield* Effect.all([one.enqueue(stream, "one"), two.enqueue(stream, "two")], {
        concurrency: "unbounded"
      })
      expect(new Set(commands.map((cmd) => cmd.key[1])).size).toBe(2)
      expect((yield* store.load).outbox.map((cmd) => cmd.payload)).toEqual(["one", "two"])
      expect((yield* one.push).map((answer) => answer._tag)).toEqual(["Accepted", "Accepted"])
      expect(yield* two.push).toEqual([])
      expect(yield* pull(server, 0)).toMatchObject({ entries: [{ events: ["one"] }, { events: ["two"] }] })
    }))

  it.effect("M5: a submit failure part way through a push loses no earlier answer", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({
        shard,
        decide: (cmd) => cmd.payload === "bad" ? { _tag: "Refused", reason: "no" } : { _tag: "Accepted", events: [1] }
      })
      let fail = true
      const flaky: ShardClient.Transport = {
        ...server,
        // The second command's connection drops once.
        submit: (request) =>
          fail && request.command.payload === "good"
            ? Effect.sync(() => void (fail = false)).pipe(Effect.andThen(Effect.die("connection reset")))
            : server.submit(request)
      }
      const store = ShardClient.memoryStore()
      const node = yield* ShardClient.make({ shard, node: "a", transport: flaky, store, apply: () => Effect.void })
      yield* node.enqueue(stream, "bad")
      yield* node.enqueue(stream, "good")
      expect(Exit.isFailure(yield* Effect.exit(node.push))).toBe(true)
      expect((yield* store.load).outbox).toHaveLength(2)
      expect((yield* store.load).terminalFailures).toBeUndefined()
      expect((yield* node.push).map((answer) => answer._tag)).toEqual(["Refused", "Accepted"])
      expect(yield* store.load).toMatchObject({
        outbox: [],
        terminalFailures: [{ _tag: "Refused", key: ["a", "0"], reason: "no" }]
      })
    }))

  it.effect("keeps a pending command when the reply names a different command", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      const transport: ShardClient.Transport = {
        ...server,
        submit: () => Effect.succeed({ _tag: "Refused", shard, key: ["other", "0"], reason: "no" })
      }
      const node = yield* ShardClient.make({
        shard, node: "a", transport, store: ShardClient.memoryStore(), apply: () => Effect.void
      })
      const pending = yield* node.enqueue(stream, "pending")
      expect(Exit.isFailure(yield* Effect.exit(node.push))).toBe(true)
      expect((yield* node.state).outbox).toEqual([pending])
      expect((yield* node.state).terminalFailures).toBeUndefined()
    }))

  it.effect("does not dequeue when a submit reply names another shard", () =>
    Effect.gen(function*() {
      const other = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:acme/other")
      const server = ShardServer.make({ shard })
      const key = ["a", "0"] as const
      const decode = Schema.decodeUnknownSync(ShardProtocol.SubmitResponse)
      expect(() => decode({ _tag: "Refused", key, reason: "no" })).toThrow()
      expect(() => decode({ _tag: "IdempotencyConflict", key, position: null })).toThrow()
      const position = { shard: other, epoch: 1, seq: 1 }
      const replies: ReadonlyArray<ShardProtocol.SubmitResponse> = [
        { _tag: "Accepted", key, position },
        { _tag: "Duplicate", key, position },
        { _tag: "StaleEpoch", key, shard: other, epoch: 1 },
        { _tag: "Refused", key, shard: other, reason: "no" },
        { _tag: "IdempotencyConflict", key, shard: other, position: null },
        { _tag: "IdempotencyConflict", key, shard, position }
      ]
      for (const reply of replies) {
        const store = ShardClient.memoryStore()
        const node = yield* ShardClient.make({
          shard, node: "a", store, apply: () => Effect.void,
          transport: { ...server, submit: () => Effect.succeed(reply) }
        })
        yield* node.enqueue(stream, "pending")
        const before = yield* store.load
        expect(yield* Effect.flip(node.push)).toMatchObject({ reason: "wrong_shard" })
        expect(yield* store.load).toEqual(before)
      }
    }))

  it.effect("does not apply or advance when a pull page or snapshot names another shard", () =>
    Effect.gen(function*() {
      const other = Schema.decodeUnknownSync(ShardProtocol.ShardId)("repo:acme/other")
      const local = ShardServer.make({ shard })
      const remote = ShardServer.make({ shard: other })
      yield* remote.submit({ version: 2, shard: other, epoch: 0, command: command("w", "1", "foreign") })
      const view = projection()
      const store = ShardClient.memoryStore()
      let reads = 0
      const snapshot = () => Effect.suspend(() => {
        reads += 1
        return remote.snapshot(other)
      })
      const open = (pull: ShardClient.Transport["pull"]) => ShardClient.make({
        shard, node: "a", store, apply: view.apply, transport: { ...local, pull, snapshot }
      })
      const foreignPull: ShardClient.Transport["pull"] = (request) => remote.pull({ ...request, shard: other })
      const foreign = yield* open(foreignPull)
      expect(yield* Effect.flip(foreign.pull)).toMatchObject({ reason: "wrong_shard" })
      yield* remote.compact(1, ["foreign"])
      expect(yield* Effect.flip(foreign.pull)).toMatchObject({ reason: "wrong_shard" })
      expect(reads).toBe(0)

      yield* submit(local, command("w", "1", "local"))
      yield* local.compact(1, ["local"])
      const wrongSnapshot = yield* open(local.pull)
      expect(yield* Effect.flip(wrongSnapshot.pull)).toMatchObject({ reason: "wrong_shard" })
      expect(reads).toBe(1)
      expect(view.deliveries).toEqual([])
      expect(yield* store.load).toEqual(ShardClient.initialState)
    }))

  it.effect("M6: a limit that is not a positive safe integer is a defect at construction", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      yield* submit(server, command("w", "1", 1))
      for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const made = yield* Effect.exit(
          ShardClient.make({ shard, node: "a", transport: server, store: ShardClient.memoryStore(), apply: () => Effect.void, limit })
        )
        expect(Exit.isFailure(made)).toBe(true)
        expect(String(Exit.isFailure(made) && made.cause)).toContain("positive safe integer")
      }
    }))
})

describe("ShardServer review regressions", () => {
  it.effect("M7: compact refuses a seq that is not a safe integer and changes nothing", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      yield* submit(server, command("a", "1", 1))
      for (const seq of [0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(yield* Effect.flip(server.compact(seq, "folded"))).toMatchObject({ reason: "out_of_range" })
      }
      expect(yield* server.snapshot(shard)).toEqual({ position: { shard, epoch: 0, seq: 0 }, state: null })
      expect(yield* pull(server, 0)).toMatchObject({ entries: [{ seq: 1 }], through: 1 })
    }))

  it.effect("M8: the memory store keeps its own copy of what it is given and hands out copies", () =>
    Effect.gen(function*() {
      const server = ShardServer.make({ shard })
      const payload = { n: 1 }
      expect(yield* submit(server, command("a", "1", payload))).toMatchObject({ _tag: "Accepted" })
      payload.n = 2
      const first = yield* pull(server, 0)
      expect(first).toMatchObject({ entries: [{ events: [{ n: 1 }] }] })
      ;(first as unknown as { entries: Array<{ events: Array<{ n: number }> }> }).entries[0]!.events[0]!.n = 3
      expect(yield* pull(server, 0)).toMatchObject({ entries: [{ events: [{ n: 1 }] }] })
      expect(yield* submit(server, command("a", "1", { n: 1 }))).toMatchObject({ _tag: "Duplicate" })
      const state = { rows: [1] }
      yield* server.compact(1, state)
      state.rows.push(2)
      const snapshot = yield* server.snapshot(shard)
      expect(snapshot.state).toEqual({ rows: [1] })
      ;(snapshot.state as { rows: Array<number> }).rows.push(3)
      expect((yield* server.snapshot(shard)).state).toEqual({ rows: [1] })
    }))
})
