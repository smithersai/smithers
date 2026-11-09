import { Effect, Logger, Redacted } from "effect"
import { inspect } from "node:util"
import { describe, expect, it } from "vitest"
import { buildAuthorizationUrl } from "../src/core/AuthorizationUrl.ts"
import * as Channel from "../src/core/Channel.vibe"
import { layerMemory } from "../src/core/CursorStore.vibe"
import type { ExternalEvent } from "../src/core/ExternalEvent.vibe"
import * as Pkce from "../src/core/Pkce.vibe"
import { toNotification } from "../src/core/SignalName.ts"
import { runWithCursor } from "../src/core/Source.vibe"
import { compareVersion } from "../src/core/SourceRecord.vibe"

const event: ExternalEvent = {
  source: "example",
  eventName: "integration:example:changed",
  correlationId: null,
  payload: {},
  dedupeKey: "delivery-one",
  receivedAtMs: 1
}

describe("core regressions", () => {
  it.each(["throw", "malformed"])("withholds decoder content from %s logs", async (mode) => {
    const secret = "private-webhook-content-917"
    const logs: Array<string> = []
    const channel = Channel.make({
      name: "example",
      credential: Redacted.make({ id: "one", name: "one" }),
      secret: Channel.constantSecret(Redacted.make("signing-secret")),
      verify: () => true,
      decode: () => {
        if (mode === "throw") throw new Error(secret)
        return { ...event, receivedAtMs: secret as unknown as number }
      },
      route: Channel.startFlow("triage")
    })
    const result = await Effect.runPromise(
      Effect.exit(channel.decode({
        body: new TextEncoder().encode("{}"),
        headers: {},
        idempotencyKey: "one"
      })).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((entry) => logs.push(inspect(entry.message, { depth: null, customInspect: false })))
          ])
        )
      )
    )
    expect(result._tag).toBe("Failure")
    expect(logs).toHaveLength(1)
    expect(logs.join("\n")).toContain("webhook decoder")
    expect(logs.join("\n")).not.toContain(secret)
  })

  it.each(["http://login.example/authorize", "http://localhost.evil.test/authorize", "http://192.168.1.2/auth"])(
    "refuses unencrypted authorization at %s",
    (authorizationEndpoint) => {
      expect(() =>
        buildAuthorizationUrl({
          authorizationEndpoint,
          clientId: "client",
          redirectUri: "https://app.example/callback",
          state: "state",
          codeChallenge: "challenge"
        })
      ).toThrow(/https/i)
    }
  )

  it("keeps unrelated uncorrelated notifications separate", () => {
    const options = {
      targetLineageId: "lineage",
      provenance: {
        sourceRunId: "run",
        sourceLineageId: "lineage",
        sourceTurn: 0,
        sourceActor: "integration:example"
      }
    }
    const first = toNotification(event, options)
    const second = toNotification({ ...event, dedupeKey: "delivery-two" }, options)
    expect(first._tag).toBe("system-event")
    expect(second._tag).toBe("system-event")
    if (first._tag !== "system-event" || second._tag !== "system-event") throw new Error("unexpected notification")
    expect(first.coalescingKey === undefined || first.coalescingKey !== second.coalescingKey).toBe(true)
  })

  it("constructs lazy verifier Effects and draws fresh randomness on each execution", async () => {
    const verifier = Pkce.createCodeVerifier()
    expect(Effect.isEffect(verifier)).toBe(true)
    // The cast lets this regression run against the old synchronous API.
    const effect = verifier as unknown as Effect.Effect<string>
    const first = await Effect.runPromise(effect)
    expect(first).toHaveLength(43)
    expect(await Effect.runPromise(effect)).not.toBe(first)
  })

  it.each(
    [
      ["verifier", () => Pkce.createCodeVerifier(1)],
      ["challenge", () => Pkce.deriveCodeChallenge("short")],
      ["pair", () => Pkce.createPkcePair(1)]
    ] as const
  )("defers %s validation into Effect execution", async (_name, construct) => {
    let effect: unknown
    expect(() => {
      effect = construct()
    }).not.toThrow()
    expect(Effect.isEffect(effect)).toBe(true)
    expect((await Effect.runPromise(Effect.exit(effect as Effect.Effect<unknown, unknown>)))._tag).toBe("Failure")
  })

  it("requires durable execution before polling or handling", async () => {
    const calls: Array<string> = []
    const program = runWithCursor("example", () =>
      Effect.sync(() => {
        calls.push("poll")
        return { events: [event] }
      }), () =>
      Effect.sync(() => {
        calls.push("handler")
      }), { maxTurns: 1 })
    // Deliberately omit the durable runtime to verify the execution boundary.
    const result = await Effect.runPromise(
      Effect.exit(program.pipe(Effect.provide(layerMemory))) as Effect.Effect<unknown>
    )
    expect(calls).toEqual([])
    expect(result).toMatchObject({ _tag: "Failure" })
  })

  it("orders mixed version tokens transitively and selects one winner in every arrival order", () => {
    const versions = ["2", "10", "1x"]
    for (const a of versions) {
      for (const b of versions) {
        for (const c of versions) {
          if (compareVersion(a, b) < 0 && compareVersion(b, c) < 0) expect(compareVersion(a, c)).toBeLessThan(0)
        }
      }
    }
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
    const winners = orders.map((order) =>
      order.map((i) => versions[i]!).reduce(
        (current, candidate) => compareVersion(current, candidate) < 0 ? candidate : current
      )
    )
    expect(new Set(winners).size).toBe(1)
  })
})

it.each([
  "https://login.example/auth",
  "http://localhost:3456/auth",
  "http://127.0.0.1/auth",
  "http://127.10.20.30/auth",
  "http://[::1]/auth"
])(
  "allows secure or loopback authorization at %s",
  (authorizationEndpoint) => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint,
        clientId: "client",
        redirectUri: "https://app.example/callback",
        state: "state",
        codeChallenge: "challenge"
      })
    )
    expect(url.searchParams.get("state")).toBe("state")
    expect(url.origin).toBe(new URL(authorizationEndpoint).origin)
  }
)
