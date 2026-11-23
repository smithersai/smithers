import { FuzzSimulation } from "@smthrs/fuzz"
import { PresenceProtocol, PresenceRoom, SharedText } from "@smthrs/sync"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Option, Schema } from "effect"
import { describe, expect } from "vitest"

const EditOp = Schema.Struct({
  replica: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
  kind: Schema.Literals(["edit", "replace", "mark"]),
  posRatio: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
  delLen: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
  text: Schema.Literals(["", "a", "bc", "\n", "é", "🚀", "hello"])
})

describe("@smthrs/sync CRDT & presence fuzz", () => {
  it.fuzz(
    "SharedText.changeOf transforms before into after exactly",
    [Schema.String, Schema.String, Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })))],
    ([before, after, caret]) => {
      const change = SharedText.changeOf(before, after, caret)
      expect(change.from).toBeGreaterThanOrEqual(0)
      expect(change.to).toBeGreaterThanOrEqual(change.from)
      expect(change.to).toBeLessThanOrEqual(before.length)
      const rebuilt = before.slice(0, change.from) + change.insert + before.slice(change.to)
      expect(rebuilt).toBe(after)
      return true
    }
  )

  it.effect.fuzz(
    "SharedText.validate never dies on arbitrary bytes and accepts valid seeds while rejecting seedClient writes",
    [
      Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(Schema.isMaxLength(128)),
      Schema.String,
      Schema.Boolean
    ],
    ([rawBytes, seedText, asSeed]) =>
      Effect.gen(function*() {
        // Arbitrary bytes must never crash validate
        const arbitraryExit = yield* Effect.exit(SharedText.validate(Uint8Array.from(rawBytes), { seed: asSeed }))
        expect(arbitraryExit._tag === "Success" || arbitraryExit._tag === "Failure").toBe(true)

        // Seed bytes must be deterministic and pass seed:true validation
        const s1 = SharedText.seed(seedText)
        const s2 = SharedText.seed(seedText)
        expect(s1).toEqual(s2)
        const validSeedExit = yield* Effect.exit(SharedText.validate(s1, { seed: true }))
        expect(validSeedExit._tag).toBe("Success")
        if (seedText.length > 0) {
          // A non-empty seed carries seedClient writes and must be rejected when seed:false
          const rejectedAsEdit = yield* Effect.exit(SharedText.validate(s1, { seed: false }))
          expect(rejectedAsEdit._tag).toBe("Failure")
        }
        return true
      })
  )

  it.effect.fuzz(
    "SharedText 3-replica concurrent edits, out-of-order & duplicate delivery converge identically (SEC)",
    [
      Schema.String.check(Schema.isMaxLength(20)),
      Schema.Array(EditOp).check(Schema.isMinLength(1), Schema.isMaxLength(18)),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))
    ],
    ([initialText, ops, shuffleSeed]) =>
      Effect.scoped(
        Effect.gen(function*() {
          const replicas = yield* Effect.all([SharedText.make, SharedText.make, SharedText.make])
          const wellFormed = initialText.toWellFormed()
          const seedBytes = SharedText.seed(wellFormed)
          for (const r of replicas) {
            yield* r.apply(seedBytes)
          }

          const updates: Array<Uint8Array> = []
          const anchors: Array<{ readonly replica: number; readonly bytes: Uint8Array }> = []

          for (const op of ops) {
            const r = replicas[op.replica]!
            const cur = yield* r.text
            const bounds: Array<number> = [0]
            for (let i = 0; i < cur.length; ) {
              const cp = cur.codePointAt(i)!
              i += cp > 0xffff ? 2 : 1
              bounds.push(i)
            }
            const bIdx = Math.min(bounds.length - 1, Math.floor((op.posRatio / 10) * bounds.length))
            const pos = bounds[bIdx]!
            const end = bounds[Math.min(bounds.length - 1, bIdx + op.delLen)]!

            if (op.kind === "edit") {
              const upd = yield* r.edit([{ from: pos, to: end, insert: op.text }])
              if (upd !== undefined) updates.push(upd)
            } else if (op.kind === "replace") {
              const next = cur.slice(0, pos) + op.text + cur.slice(end)
              const upd = yield* r.replace(next, { caret: pos + op.text.length, base: cur })
              if (upd !== undefined) updates.push(upd)
            } else {
              const upd = yield* r.mark(`k${op.posRatio % 3}`, op.text)
              if (upd !== undefined) updates.push(upd)
            }

            const a = yield* r.anchor(pos)
            anchors.push({ replica: op.replica, bytes: a })
          }

          // Deliver all updates to each replica in a DIFFERENT deterministic permutation, twice (idempotency!)
          for (let rIdx = 0; rIdx < replicas.length; rIdx++) {
            const order = updates.map((_, i) => i)
            let state = (shuffleSeed + rIdx * 9973) >>> 0
            for (let i = order.length - 1; i > 0; i--) {
              state = (Math.imul(state, 1664525) + 1013904223) >>> 0
              const j = state % (i + 1)
              const tmp = order[i]!
              order[i] = order[j]!
              order[j] = tmp
            }
            for (let pass = 0; pass < 2; pass++) {
              for (const idx of order) {
                yield* replicas[rIdx]!.apply(updates[idx]!)
              }
            }
          }

          // Strong Eventual Consistency: all 3 replicas MUST have identical text AND marks!
          const texts = yield* Effect.all(replicas.map((r) => r.text))
          expect(texts[0]).toBe(texts[1])
          expect(texts[1]).toBe(texts[2])

          const marks = yield* Effect.all(replicas.map((r) => r.marks))
          expect(marks[0]).toEqual(marks[1])
          expect(marks[1]).toEqual(marks[2])

          // Every anchor resolves within [0, text.length] on every replica
          for (const a of anchors) {
            for (const r of replicas) {
              const resolved = yield* r.resolve(a.bytes)
              if (Option.isSome(resolved)) {
                expect(resolved.value).toBeGreaterThanOrEqual(0)
                expect(resolved.value).toBeLessThanOrEqual(texts[0]!.length)
              }
            }
          }
          return true
        })
      )
  )

  it.effect.fuzz(
    "PresenceRoom never leaks host data and cleans up evicted or closed sockets under FuzzSimulation",
    [
      Schema.Array(
        Schema.Struct({
          op: Schema.Literals(["join", "frame", "leave", "evict"]),
          who: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
          payload: Schema.String.check(Schema.isMaxLength(80))
        })
      ).check(Schema.isMinLength(1), Schema.isMaxLength(20))
    ],
    ([steps]) =>
      Effect.gen(function*() {
        interface FakeSocket extends PresenceRoom.RoomSocket {
          readonly id: number
          readonly sent: Array<string>
          closed: boolean
          attachment: unknown
        }
        const sockets: Array<FakeSocket> = []
        const makeSocket = (id: number): FakeSocket => {
          const s: FakeSocket = {
            id,
            sent: [],
            closed: false,
            attachment: null,
            send: (text) =>
              Effect.sync(() => {
                if (s.closed) throw new Error("closed")
                s.sent.push(text)
              }),
            close: () =>
              Effect.sync(() => {
                s.closed = true
              }),
            serializeAttachment: (v) => {
              s.attachment = v
            },
            deserializeAttachment: <T>() => s.attachment as T | null
          }
          return s
        }
        const host: PresenceRoom.RoomHost<FakeSocket> = {
          sockets: Effect.sync(() => sockets.filter((s) => !s.closed))
        }
        const secretHostData = "HOST_PRIVATE_OPAQUE_DATA_999"

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i]!
          const principal = `user-${step.who}`
          if (step.op === "join") {
            const s = makeSocket(i)
            sockets.push(s)
            yield* PresenceRoom.join(host, s, {
              principal,
              name: `User ${step.who}`,
              access: "write",
              data: secretHostData
            })
          } else if (step.op === "frame") {
            const active = sockets.find((s) => !s.closed)
            if (active !== undefined) {
              const raw = i % 2 === 0
                ? JSON.stringify({ type: "state", state: { view: step.payload } })
                : step.payload
              yield* PresenceRoom.receive(host, active, raw)
            }
          } else if (step.op === "leave") {
            const active = sockets.find((s) => !s.closed)
            if (active !== undefined) {
              active.closed = true
              yield* PresenceRoom.leave(host, active)
            }
          } else {
            yield* PresenceRoom.evict(host, principal, PresenceProtocol.CloseCode.AccessRevoked, "revoked")
            const remaining = yield* PresenceRoom.connections(host)
            expect(remaining.some((c) => c.participant.principal === principal)).toBe(false)
          }
        }

        // Host-only `data` must NEVER appear in any frame sent to any socket!
        for (const s of sockets) {
          for (const frame of s.sent) {
            expect(frame).not.toContain(secretHostData)
          }
        }
        return true
      }),
    { fuzz: { execution: FuzzSimulation.execution({ maxSteps: 100_000 }) } }
  )
})
