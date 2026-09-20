/**
 * The model transport `smithers opencode` serves a directory on.
 *
 * A provider can destroy the HTTP/2 session under a connection pool, and
 * waiting does not bring it back: every attempt that reuses the pool holding it
 * fails the same way however long the retry ladder waits between them. Two live
 * servers met that on 2026-09-19 and then failed three and two consecutive
 * turns, each ending "stopped: the model call failed" after about forty seconds
 * of retrying, with one frame and no spend, while a third server on the same
 * key and the same machine answered normally. Only a restart fixed them.
 *
 * `RequestExecutor` already has the rung the ladder did not have: after
 * `rebuildAfter` consecutive transport failures the next attempt is made on a
 * client the host built fresh. It only works if the host actually has a pool to
 * replace, which is what `NodeControl.layerRebuildableRequestExecutor` gives it
 * and what `RequestExecutor.layer` over `NodeHttpClient.layerUndici` does not.
 *
 * The condition is driven here the way the model boundary already simulates it:
 * a pool that refuses every request identically, which is what a destroyed
 * session looks like from above. The turn that meets it fails, and the turn
 * after it runs on a pool the host built fresh and answers.
 */
import { MockAgent } from "@effect/platform-node/Undici"
import type * as Undici from "@effect/platform-node/Undici"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/kernel/CapabilitySet"
import { Effect, Exit, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as OpenCode from "../src/commands/OpenCode.ts"

const roots: Array<string> = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-opencode-transport-"))
  roots.push(root)
  return root
}

/** One turn's worth of wire: a word and a stop. */
const answer = [
  "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"back\"},\"finish_reason\":null}]}",
  "",
  "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"\"},\"finish_reason\":\"stop\"}]}",
  "",
  "data: [DONE]",
  "",
  ""
].join("\n")

const prompt = {
  modelId: "gpt-oss-120b",
  system: [],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  params: {}
} as never

describe("smithers opencode model transport", () => {
  it("checks the model capability ceiling before sending, including after pool replacement", async () => {
    const acquired: Array<MockAgent> = []
    const acquire = Effect.gen(function*() {
      const agent = new MockAgent()
      agent.disableNetConnect()
      if (acquired.length > 0) {
        agent.get("https://api.cerebras.ai").intercept({ method: "POST", path: "/v1/chat/completions" })
          .reply(200, answer, { headers: { "content-type": "text/event-stream" } })
      }
      acquired.push(agent)
      yield* Effect.addFinalizer(() => Effect.promise(() => agent.close()))
      return agent as unknown as Undici.Dispatcher
    })
    const host = OpenCode.nodeHost(scratch(), { CEREBRAS_API_KEY: "test-key" }, acquire)
    await Effect.runPromise(
      Effect.gen(function*() {
        const seats = yield* SeatResolver.SeatResolver
        const seat = yield* seats.resolve("cerebras:gpt-oss-120b")
        const turn = () => Effect.scoped(Stream.runCollect(seat.model.stream(prompt)))
        const forbidden = () =>
          turn().pipe(
            CapabilitySet.attenuate([
              new CapabilityPattern({ action: "model:call", resource: "api.cerebras.ai/other-model" })
            ]),
            Effect.flip
          )
        expect(yield* forbidden()).toMatchObject({ code: "permission_denied", reason: "outside capability ceiling" })
        expect(yield* Effect.flip(turn())).toMatchObject({ code: "transport" })
        expect(yield* forbidden()).toMatchObject({ code: "permission_denied", reason: "outside capability ceiling" })
        expect(acquired).toHaveLength(2)
        expect(Array.from(yield* turn())).toContainEqual({ type: "text-delta", id: "text-0", text: "back" })
      }).pipe(Effect.provide(host.seats), Effect.scoped)
    )
  }, 60_000)

  it("checks the caller's model capability before sending a request", async () => {
    let requests = 0
    const acquire = Effect.gen(function*() {
      const agent = new MockAgent()
      agent.disableNetConnect()
      agent.get("https://api.cerebras.ai").intercept({ method: "POST", path: "/v1/chat/completions" })
        .reply(200, () => {
          requests++
          return answer
        }, { headers: { "content-type": "text/event-stream" } })
        .persist()
      yield* Effect.addFinalizer(() => Effect.promise(() => agent.close()))
      return agent as unknown as Undici.Dispatcher
    })
    const host = OpenCode.nodeHost(scratch(), { CEREBRAS_API_KEY: "test-key" }, acquire)
    await Effect.runPromise(
      Effect.gen(function*() {
        const seat = yield* (yield* SeatResolver.SeatResolver).resolve("cerebras:gpt-oss-120b")
        const turn = () => Effect.scoped(Stream.runCollect(seat.model.stream(prompt)))
        const denied = yield* turn().pipe(CapabilitySet.attenuate([]), Effect.exit)
        expect(Exit.isFailure(denied)).toBe(true)
        expect(requests).toBe(0)
        const allowed = yield* turn().pipe(CapabilitySet.attenuate([
          new CapabilityPattern({ action: "model:call", resource: "api.cerebras.ai/gpt-oss-120b" })
        ]))
        expect(Array.from(allowed)).toContainEqual({ type: "text-delta", id: "text-0", text: "back" })
        expect(requests).toBe(1)
        // A network grant and a different model's grant are neither this seat's authority.
        for (
          const pattern of [
            new CapabilityPattern({ action: "net:post", resource: "api.cerebras.ai" }),
            new CapabilityPattern({ action: "model:call", resource: "api.cerebras.ai/another-model" })
          ]
        ) {
          const result = yield* turn().pipe(CapabilitySet.attenuate([pattern]), Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
          expect(requests).toBe(1)
        }
      }).pipe(Effect.provide(host.seats), Effect.scoped)
    )
  })

  it("answers the turn after the one whose connection pool died", async () => {
    const acquired: Array<MockAgent> = []
    const closed: Array<MockAgent> = []
    // The first pool is the poisoned one: it refuses every request, identically,
    // however long the ladder waits. The second is a pool that works.
    const acquire = Effect.gen(function*() {
      const agent = new MockAgent()
      agent.disableNetConnect()
      if (acquired.length > 0) {
        agent.get("https://api.cerebras.ai").intercept({ method: "POST", path: "/v1/chat/completions" }).reply(
          200,
          answer,
          { headers: { "content-type": "text/event-stream" } }
        )
      }
      acquired.push(agent)
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          closed.push(agent)
          await agent.close()
        })
      )
      return agent as unknown as Undici.Dispatcher
    })

    const host = OpenCode.nodeHost(scratch(), { CEREBRAS_API_KEY: "test-key" }, acquire)

    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const seats = yield* SeatResolver.SeatResolver
        const seat = yield* seats.resolve("cerebras:gpt-oss-120b")
        const turn = () => Effect.scoped(Stream.runCollect(seat.model.stream(prompt)))
        // The turn that meets the dead session. One `execute` spends the
        // executor's whole ladder on it, which is what reaches the bound.
        const first = yield* Effect.flip(turn())
        // Rebuilding the transport must retain its permission guard too.
        const denied = yield* turn().pipe(CapabilitySet.attenuate([]), Effect.exit)
        expect(Exit.isFailure(denied)).toBe(true)
        // The next turn. On a host whose rebuild hands back the pool that just
        // failed, this fails identically and the person restarts the server.
        const second = yield* turn()
        return { first, second: Array.from(second), pools: acquired.length, closedDuringRun: [...closed] }
      }).pipe(Effect.provide(host.seats), Effect.scoped)
    )

    expect(String(outcome.first)).toContain("transport")
    expect(outcome.second).toContainEqual({ type: "text-delta", id: "text-0", text: "back" })
    // Two pools were built, and the dead one was destroyed the moment the
    // replacement was in hand: a server that keeps meeting dead sessions holds
    // one pool, not a queue of them.
    expect(outcome.pools).toBe(2)
    expect(outcome.closedDuringRun).toEqual([acquired[0]])
  }, 60_000)

  it("keeps one pool while the provider answers", async () => {
    const acquired: Array<MockAgent> = []
    const acquire = Effect.gen(function*() {
      const agent = new MockAgent()
      agent.disableNetConnect()
      agent.get("https://api.cerebras.ai").intercept({ method: "POST", path: "/v1/chat/completions" })
        .reply(200, answer, { headers: { "content-type": "text/event-stream" } })
        .times(2)
      acquired.push(agent)
      yield* Effect.addFinalizer(() => Effect.promise(() => agent.close()))
      return agent as unknown as Undici.Dispatcher
    })

    const host = OpenCode.nodeHost(scratch(), { CEREBRAS_API_KEY: "test-key" }, acquire)

    const pools = await Effect.runPromise(
      Effect.gen(function*() {
        const seats = yield* SeatResolver.SeatResolver
        const seat = yield* seats.resolve("cerebras:gpt-oss-120b")
        yield* Effect.scoped(Stream.runCollect(seat.model.stream(prompt)))
        yield* Effect.scoped(Stream.runCollect(seat.model.stream(prompt)))
        return acquired.length
      }).pipe(Effect.provide(host.seats), Effect.scoped)
    )

    // A client that answers is a client that works: nothing is thrown away.
    expect(pools).toBe(1)
  }, 30_000)
})
