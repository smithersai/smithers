import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { expect, test } from "vitest"
import { DEVICE_PERSON_HEADER, type SessionState } from "../src/features/auth/contract.ts"
import { Sessions } from "./Actor.vibe"
import { testFile } from "./test/harness.ts"
import { cookie, signInHarness } from "./test/signIn.ts"

const runtime = testFile("generated_session_principals")

test("cookie and device binding resolve the signed-in person or refuse each generated request", async () => {
  const auth = await signInHarness(runtime)
  const { cookies } = await auth.signInAs()
  const state = await auth.session(cookies) as SessionState
  if (!state.signedIn || !state.personId) throw new Error("missing signed-in test principal")
  const person = state.personId
  const scenarios = Arbitrary.schema(Schema.Struct({
    method: Schema.Literals(["GET", "POST"]),
    credential: Schema.Literals(["valid", "absent", "invalid"]),
    device: Schema.Literals(["same", "other", "absent"]),
    invalidBearer: Schema.Boolean,
  }))
  const report = await runtime.runPromise(Fuzz.run(scenarios, scenario => Effect.gen(function* () {
    const headers = new Headers()
    if (scenario.credential === "valid") headers.set("cookie", cookie(cookies))
    if (scenario.credential === "invalid") headers.set("cookie", cookie(Object.fromEntries(Object.keys(cookies).map(key => [key, "invalid"]))))
    if (scenario.device !== "absent") headers.set(DEVICE_PERSON_HEADER, scenario.device === "same" ? person : "another")
    if (scenario.invalidBearer) headers.set("authorization", "Bearer invalid")
    const request = HttpServerRequest.fromWeb(new Request("http://smithers.test/api/repos", { headers, method: scenario.method }))
    const principal = yield* Effect.flatMap(Sessions, sessions => sessions.resolve).pipe(
      Effect.provide(auth.sessions), Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    )
    const admitted = scenario.credential === "valid" && !scenario.invalidBearer && scenario.device !== "other" &&
      (scenario.method === "GET" || scenario.device === "same")
    if (admitted) {
      expect(Option.getOrThrow(principal)).toMatchObject({ subject: { kind: "person", id: person }, role: state.role })
      expect(Option.getOrThrow(principal).act).toBeUndefined()
    } else {
      expect(Option.isNone(principal)).toBe(true)
    }
    return true
  }), { seed: Number(process.env.EFFECT_FUZZ_SEED ?? 20261134), executions: Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? 100) }))
  expect(Fuzz.formatReport(report)).toBeUndefined()
})
