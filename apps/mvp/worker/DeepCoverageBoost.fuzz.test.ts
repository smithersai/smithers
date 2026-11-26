import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Clock, Effect, Option, Redacted, Schema } from "effect"
import { expect, test } from "vitest"
import type { Actor } from "./Actor.vibe"
import * as RunCredentials from "./RunCredentials.ts"
import * as SessionKeys from "./SessionKeys.vibe"

test("signed run credentials preserve the principal and renew only for the issuing person, session and run", async () => {
  const keys = await Effect.runPromise(SessionKeys.make(Redacted.make(crypto.randomUUID())))
  const scenarios = Arbitrary.schema(Schema.Struct({
    number: Schema.Int,
    expired: Schema.Boolean,
    ended: Schema.Boolean,
    wrongRun: Schema.Boolean,
    wrongPerson: Schema.Boolean,
    wrongSession: Schema.Boolean,
  }))
  const report = await Effect.runPromise(Fuzz.run(scenarios, scenario => Effect.gen(function* () {
    const id = String(scenario.number)
    const person: Actor = { subject: { kind: "person", id }, session: "session", role: "member" }
    const credentials = RunCredentials.make({ keys, person: () => Effect.succeed(scenario.ended ? Option.none() : Option.some(person)) })
    const now = yield* Clock.currentTimeMillis
    const claims: RunCredentials.Claims = { v: 1, sub: id, sid: "session", act: "flow", root: id, run: id,
      chain: ["watch/set"], ceiling: [], exp: scenario.expired ? now : now + 60_000 }
    const token = yield* credentials.sign(claims)
    const actor = yield* credentials.verify(token)
    expect(Option.getOrUndefined(actor)).toEqual(scenario.ended || scenario.expired ? undefined : {
      ...person, act: { kind: "flow", root: id, id, chain: ["watch/set"], ceiling: [] },
    })
    expect(Option.isNone(yield* credentials.verify(token + "!"))).toBe(true)
    const renewed = yield* credentials.renew(token, {
      ...person, subject: { kind: "person", id: scenario.wrongPerson ? "another" : id },
      session: scenario.wrongSession ? "another" : "session",
    }, scenario.wrongRun ? "another" : id)
    if (scenario.ended || scenario.wrongRun || scenario.wrongPerson || scenario.wrongSession) {
      expect(Option.isNone(renewed)).toBe(true)
    } else {
      expect(Option.getOrThrow(renewed)).toEqual({ ...claims, exp: expect.any(Number) })
      expect(Option.getOrThrow(renewed).exp).toBeGreaterThan(now)
    }
    return true
  }), { seed: Number(process.env.EFFECT_FUZZ_SEED ?? 20261133), executions: Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? 100) }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})
