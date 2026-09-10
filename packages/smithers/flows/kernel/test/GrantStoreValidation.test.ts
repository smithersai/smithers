import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import type { Rule } from "@smthrs/capability/Permission"
import { Effect, Fiber } from "effect"
import type { GrantEvent } from "../src/GrantEvent.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

/**
 * The two pattern validators are the only thing standing between an approver's
 * click and an over-broad durable rule. They are shared by the runtime reply
 * path, the envelope path, and journal replay, so they are exercised here
 * directly as an implementation-contract matrix, and then through `reply` to
 * prove the store actually consults them.
 */

const root = "/workspace"

const capability = (action: Capability["action"], resource: string) => new Capability({ action, resource })
const pattern = (action: CapabilityPattern["action"], resource: string) => new CapabilityPattern({ action, resource })

const insideWrite = capability("fs:write", "/workspace/file.txt")
const outsideWrite = capability("fs:write", "/outside/file.txt")
const read = capability("fs:read", "/workspace/readme.md")

interface GrantCase {
  readonly name: string
  readonly pattern: CapabilityPattern
  readonly capability: Capability
  readonly tier: Parameters<typeof GrantStore.isValidGrantPattern>[2]
  readonly valid: boolean
}

const grantCases: ReadonlyArray<GrantCase> = [
  {
    name: "an exact pattern for the requested capability",
    pattern: pattern("fs:write", "/workspace/file.txt"),
    capability: insideWrite,
    tier: "compensable",
    valid: true
  },
  {
    name: "a workspace glob for a compensable write",
    pattern: pattern("fs:write", "/workspace/**"),
    capability: insideWrite,
    tier: "compensable",
    valid: true
  },
  {
    name: "the bare workspace root for a compensable write",
    pattern: pattern("fs:write", "/workspace"),
    capability: capability("fs:write", "/workspace"),
    tier: "compensable",
    valid: true
  },
  {
    name: "a wildcard action instead of the requested action",
    pattern: pattern("fs:*", "/workspace/**"),
    capability: insideWrite,
    tier: "compensable",
    valid: false
  },
  {
    name: "a pattern that does not match the requested capability",
    pattern: pattern("fs:write", "/workspace/other/**"),
    capability: insideWrite,
    tier: "compensable",
    valid: false
  },
  {
    name: "a displayed tier that disagrees with the real tier of the capability",
    pattern: pattern("fs:write", "/workspace/file.txt"),
    capability: insideWrite,
    tier: "irreversible",
    valid: false
  },
  {
    name: "a sealed non-filesystem capability with a matching exact pattern",
    pattern: pattern("fs:read", "/workspace/readme.md"),
    capability: read,
    tier: "sealed",
    valid: true
  },
  {
    name: "an allegedly exact star-bearing command",
    pattern: pattern("proc:spawn", "rm *.tmp"),
    capability: capability("proc:spawn", "rm *.tmp"),
    tier: "irreversible",
    valid: false
  },
  {
    name: "an allegedly exact question-mark-bearing URL",
    pattern: pattern("net:get", "https://example.test/search?q=1"),
    capability: capability("net:get", "https://example.test/search?q=1"),
    tier: "sealed",
    valid: false
  },
  {
    name: "a deliberately broadened non-filesystem grant",
    pattern: pattern("proc:spawn", "npm *"),
    capability: capability("proc:spawn", "npm install"),
    tier: "irreversible",
    valid: true
  },
  {
    name: "an exact pattern for an irreversible outside write",
    pattern: pattern("fs:write", "/outside/file.txt"),
    capability: outsideWrite,
    tier: "irreversible",
    valid: true
  },
  {
    name: "a star glob for an irreversible outside write",
    pattern: pattern("fs:write", "/outside/**"),
    capability: outsideWrite,
    tier: "irreversible",
    valid: false
  },
  {
    name: "a question-mark glob for an irreversible outside write",
    pattern: pattern("fs:write", "/outside/file.tx?"),
    capability: outsideWrite,
    tier: "irreversible",
    valid: false
  },
  {
    name: "a compensable glob that reaches outside the workspace",
    pattern: pattern("fs:write", "**"),
    capability: insideWrite,
    tier: "compensable",
    valid: false
  }
]

interface EnvelopeCase {
  readonly name: string
  readonly pattern: CapabilityPattern
  readonly valid: boolean
}

const envelopeCases: ReadonlyArray<EnvelopeCase> = [
  { name: "an exact non-filesystem action", pattern: pattern("net:get", "example.test"), valid: true },
  { name: "a wildcard action", pattern: pattern("net:*", "example.test"), valid: false },
  { name: "the universal action", pattern: pattern("*", "**"), valid: false },
  { name: "an exact write with no glob", pattern: pattern("fs:write", "/outside/file.txt"), valid: true },
  { name: "a write glob inside the workspace", pattern: pattern("fs:write", "/workspace/**"), valid: true },
  { name: "a write glob outside the workspace", pattern: pattern("fs:write", "/outside/**"), valid: false },
  {
    name: "a question-mark write glob outside the workspace",
    pattern: pattern("fs:write", "/outside/?.txt"),
    valid: false
  },
  { name: "a read glob anywhere", pattern: pattern("fs:read", "**"), valid: true }
]

const make = (options?: GrantStore.MakeOptions) => GrantStore.make(options).pipe(Effect.provide(Workspace.layer(root)))

const itEffect = <A, E>(name: string, body: () => Effect.Effect<A, E>): void => {
  it.effect(name, () => body())
}

const awaitPending = (
  store: GrantStore.Service,
  count: number
): Effect.Effect<ReadonlyArray<GrantStore.PendingRequest>> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending.length >= count
        ? Effect.succeed(pending)
        : Effect.yieldNow.pipe(Effect.andThen(awaitPending(store, count))))
  )

describe("GrantStore.isValidGrantPattern", () => {
  for (const testCase of grantCases) {
    it(`${testCase.valid ? "accepts" : "rejects"} ${testCase.name}`, () => {
      expect(
        GrantStore.isValidGrantPattern(testCase.pattern, testCase.capability, testCase.tier, root)
      ).toBe(testCase.valid)
    })
  }

  it("tolerates a workspace root with a trailing separator", () => {
    expect(
      GrantStore.isValidGrantPattern(pattern("fs:write", "/workspace/**"), insideWrite, "compensable", "/workspace/")
    ).toBe(true)
  })
})

describe("GrantStore.isValidEnvelopePattern", () => {
  for (const testCase of envelopeCases) {
    it(`${testCase.valid ? "accepts" : "rejects"} ${testCase.name}`, () => {
      expect(GrantStore.isValidEnvelopePattern(testCase.pattern, root)).toBe(testCase.valid)
    })
  }
})

describe("GrantStore.reply", () => {
  itEffect("fails a runtime-invalid resolution without stranding its waiter", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const waiter = yield* store.check(read).pipe(Effect.forkChild({ startImmediately: true }))
        const [pending] = yield* awaitPending(store, 1)
        const invalid = "allow-forever" as unknown as GrantStore.Resolution
        const failure = yield* Effect.flip(store.reply(pending!.requestId, invalid))

        // An unknown verb must never be read as an authorization: the reply
        // fails, the request stays parked, and the waiter is still pending.
        expect(failure.code).toBe("invalid_resolution")
        expect((yield* store.list).map((request) => request.requestId)).toEqual([pending!.requestId])
        expect(waiter.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(waiter)
      })
    ))

  itEffect("refuses a run grant when no plan digest is active", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const waiter = yield* store.check(read).pipe(Effect.forkChild({ startImmediately: true }))
        const [pending] = yield* awaitPending(store, 1)

        const failure = yield* Effect.flip(store.reply(pending!.requestId, "run"))
        expect(failure.code).toBe("invalid_resolution")
        expect(failure.message).toBe("run grants require a plan digest")
        // The request stays pending, so the caller can still answer it.
        expect(yield* store.list).toHaveLength(1)

        yield* store.reply(pending!.requestId, "once")
        yield* Fiber.join(waiter)
      })
    ))

  itEffect("refuses an empty active plan digest at construction", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const failure = yield* Effect.flip(make({ planDigest: "" }))
        expect(failure).toMatchObject({
          code: "invalid_resolution",
          message: "planDigest is empty, malformed, or too long"
        })
      })
    ))

  itEffect("defaults a run grant with no supplied pattern to the exact capability", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const events: Array<GrantEvent> = []
        const store = yield* make({
          planDigest: "plan-1",
          persist: (event) =>
            Effect.sync(() => {
              events.push(event)
            })
        })
        const waiter = yield* store.check(read).pipe(Effect.forkChild({ startImmediately: true }))
        const [pending] = yield* awaitPending(store, 1)
        yield* store.reply(pending!.requestId, "run")
        yield* Fiber.join(waiter)

        expect(events).toMatchObject([
          {
            eventType: "flows.kernel.grant.run.v2",
            pattern: { action: "fs:read", resource: "/workspace/readme.md" }
          }
        ])
        // The run rule authorizes the same resource again, but nothing wider.
        yield* store.check(read)
      })
    ))

  itEffect("refuses to derive an exact run grant from a metacharacter resource", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ planDigest: "plan-1" })
        const waiter = yield* store.check(capability("proc:spawn", "rm *.tmp")).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)

        const failure = yield* Effect.flip(store.reply(pending!.requestId, "run"))
        expect(failure).toMatchObject({
          code: "invalid_resolution",
          message:
            "the requested resource contains glob metacharacters; supply an explicit grant pattern or resolve once"
        })
        expect(yield* store.list).toHaveLength(1)

        yield* store.reply(pending!.requestId, "once")
        yield* Fiber.join(waiter)
      })
    ))

  itEffect("rejects a supplied pattern that merely restates a metacharacter resource", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ planDigest: "plan-1" })
        const waiter = yield* Effect.flip(store.check(capability("proc:spawn", "rm *.tmp"))).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)

        const failure = yield* Effect.flip(
          store.reply(pending!.requestId, "remembered", pattern("proc:spawn", "rm *.tmp"))
        )
        expect(failure).toMatchObject({
          code: "invalid_resolution",
          message: "grant pattern exceeds the requested authority"
        })
        expect(yield* store.list).toHaveLength(1)

        yield* store.reply(pending!.requestId, "deny")
        expect(yield* Fiber.join(waiter)).toMatchObject({ code: "permission_denied" })
      })
    ))

  itEffect("records a denial without run or plan identity when the store has none", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const events: Array<GrantEvent> = []
        const store = yield* make({
          persist: (event) =>
            Effect.sync(() => {
              events.push(event)
            })
        })
        const waiter = yield* Effect.flip(store.check(read)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)
        yield* store.reply(pending!.requestId, "deny")

        const failure = yield* Fiber.join(waiter)
        expect(failure).toMatchObject({ code: "permission_denied", reason: "permission request denied" })
        expect(events).toHaveLength(1)
        const [event] = events
        expect(event).toMatchObject({ eventType: "flows.kernel.grant.denied.v1", runId: "", scope: "once" })
        expect(event).not.toHaveProperty("planDigest")
        expect(yield* store.list).toEqual([])
      })
    ))

  itEffect("leaves waiters outside a remembered grant pending", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const covered = yield* store.check(read).pipe(Effect.forkChild({ startImmediately: true }))
        const uncovered = yield* store.check(capability("fs:read", "/outside/other.md")).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const pending = yield* awaitPending(store, 2)

        yield* store.reply(pending[0]!.requestId, "remembered", pattern("fs:read", "/workspace/**"))
        yield* Fiber.join(covered)
        expect(uncovered.pollUnsafe()).toBeUndefined()
        expect((yield* store.list).map((request) => request.capability.resource))
          .toEqual(["/outside/other.md"])
        yield* Fiber.interrupt(uncovered)
      })
    ))

  itEffect("refuses a reply for an unknown request id", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        expect((yield* Effect.flip(store.reply("permission-404", "once"))).code).toBe("request_not_found")
      })
    ))
})

describe("GrantStore malformed policy input", () => {
  itEffect("rejects an invalid runtime envelope scope with a typed store error", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ planDigest: "plan-1" })
        const failure = yield* Effect.flip(store.grantEnvelope({
          planDigest: "plan-1",
          patterns: [pattern("fs:read", "/workspace/**")],
          scope: "once" as unknown as "run" | "remembered"
        }))
        expect(failure.code).toBe("invalid_resolution")
        expect(yield* store.list).toEqual([])
      })
    ))

  itEffect("treats a sparse nested ruleset as an empty configured policy", () =>
    Effect.scoped(
      Effect.gen(function*() {
        // A policy decoded from sparse JavaScript input has no first ruleset.
        // It must retain the default ask behavior instead of crashing while
        // normalizing configuration.
        const rules: ReadonlyArray<ReadonlyArray<Rule>> = new Array(1)
        const store = yield* make({ attended: false, rules })
        expect((yield* Effect.flip(store.check(read))).code).toBe("permission_required")
      })
    ))
})
