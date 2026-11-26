// Who may act (worker/Actor.ts): the roles that may ask Smithers, decision 0007 §2's `repo:ask`, and clone.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Logger, Metric, Option } from "effect"
import { HttpServerRequest } from "effect/http"
import { describe, expect, test } from "vitest"
import { ROLES } from "../src/features/auth/contract.ts"
import { type Actor, Sessions, SessionsUnavailable, rankOf, signedOut, boundTo, canAsk, canClone, PERSON_ONLY_FLOWS, refusesCredential, refusesPersonOnly, personOnlyRefusals } from "./Actor.vibe"

const person = (role: Actor["role"], act?: Actor["act"]): Actor => ({
  subject: { kind: "person", id: `person-${role ?? "none"}` },
  role,
  ...(act === undefined ? {} : { act }),
})

test("role rank increases with authority and signed-out sessions resolve no actor", async () => {
  expect([...ROLES, null].map(rankOf)).toEqual([4, 3, 2, 1, 0])
  expect(new SessionsUnavailable().errorCode).toBeUndefined()
  expect(new SessionsUnavailable({ errorCode: "stale" }).errorCode).toBe("stale")
  const session = Effect.gen(function* () {
    const sessions = yield* Sessions
    return yield* sessions.resolve
  }).pipe(
    Effect.provide(signedOut),
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request("https://smithers.test"))),
  )
  expect(await Effect.runPromise(session)).toEqual(Option.none())
})

describe("canAsk", () => {
  test("Member and above may ask; a Guest and a person with no role may not", () => {
    expect([...ROLES, null].map((role) => [role, canAsk(person(role))])).toEqual([
      ["admin", true],
      ["maintainer", true],
      ["member", true],
      ["guest", false],
      [null, false],
    ])
  })

  test("an agent acting for a person asks with that person's role", () => {
    expect(canAsk(person("member", { kind: "agent", id: "agent-1" }))).toBe(true)
    expect(canAsk(person("guest", { kind: "agent", id: "agent-1" }))).toBe(false)
  })
})

describe("canClone", () => {
  test("Member and above may clone; a Guest and a person with no role may not", () => {
    expect([...ROLES, null].map((role) => [role, canClone(person(role))])).toEqual([
      ["admin", true],
      ["maintainer", true],
      ["member", true],
      ["guest", false],
      [null, false],
    ])
  })
})


describe("run binding", () => {
  test("distinct opaque identifiers remain case sensitive", () => {
    expect(boundTo(person("member", { kind: "agent", id: "Run-A" }), "run-a")).toBe(false)
    expect(boundTo(person("member", { kind: "agent", id: "Run-A" }), "Run-A")).toBe(true)
    expect(boundTo(person("member", { kind: "flow", id: "child", root: "Root-A" }), "root-a")).toBe(false)
    expect(boundTo(person("member", { kind: "flow", id: "child", root: "Root-A" }), "Root-A")).toBe(true)
  })

  test("UUID spellings bind to the same Postgres run", () => {
    const id = "aabbccdd-1234-4567-89ab-aabbccddeeff"
    expect(boundTo(person("member", { kind: "agent", id }), id.toUpperCase())).toBe(true)
    expect(boundTo(person("member", { kind: "flow", id: "child", root: id.toUpperCase() }), id)).toBe(true)
    expect(boundTo(person("member", { kind: "agent", id }), "00000000-0000-0000-0000-000000000000")).toBe(false)
    expect(boundTo(person("member"), "any-run")).toBe(true)
    expect(boundTo(person("member", { kind: "flow", id: "child", root: "root" }), "root")).toBe(true)
    expect(boundTo(person("member", { kind: "flow", id: "child", root: "root" }), "child")).toBe(false)
  })
})


describe("credential and person-only refusal", () => {
  test("only flows with a protected route refuse credentials", () => {
    for (const [flow, enforcement] of Object.entries(PERSON_ONLY_FLOWS)) {
      expect(refusesCredential(flow)).toBe("route" in enforcement)
    }
    expect(refusesCredential("unknown/flow")).toBe(false)
    expect(refusesCredential("toString")).toBe(false)
  })

  test("every acting kind is refused, logged and counted; a person is allowed", async () => {
    const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const registry: Metric.MetricRegistry = new Map()
    const logger = Logger.make((entry) => { logs.push(StructuredLogger.formatStructured.log(entry)) })
    await Effect.runPromise(Effect.gen(function* () {
      expect(yield* refusesPersonOnly(person("admin"), "alert/channel")).toBe(false)
      for (const kind of ["agent", "flow", "app", "sandbox"] as const) {
        expect(yield* refusesPersonOnly(person("admin", { kind, id: "run", chain: ["root", "child"] }), "alert/channel")).toBe(true)
        expect((yield* Metric.value(Metric.withAttributes(personOnlyRefusals, { act: "alert/channel", by: kind }))).count).toBe(1)
      }
    }).pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
    ))
    expect(logs).toHaveLength(4)
    for (const log of logs) {
      expect(log.message).toContain("auth.person_only")
      expect(log.annotations).toMatchObject({ act: "alert/channel", runId: "run", depth: 2 })
    }
  })

  test("a refusal whose run id is caller-chosen text logs the act, who tried and the depth, never the run id", async () => {
    const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const logger = Logger.make((entry) => { logs.push(StructuredLogger.formatStructured.log(entry)) })
    await Effect.runPromise(Effect.gen(function* () {
      expect(yield* refusesPersonOnly(person("admin", { kind: "agent", id: "chosen/run text" }), "conversation/ask", { runId: false })).toBe(true)
    }).pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, new Map()),
    ))
    expect(logs).toHaveLength(1)
    expect(logs[0]!.annotations).toEqual({ act: "conversation/ask", by: "agent", depth: 1 })
    expect(JSON.stringify(logs)).not.toContain("chosen/run text")
  })
})
