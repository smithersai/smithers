import { Effect, Metric, Option, Redacted } from "effect"
import { HttpServerRequest } from "effect/http"
import { expect, test } from "vitest"
import { DEVICE_PERSON_HEADER } from "../src/features/auth/contract.ts"
import * as Credentials from "./RunCredentials.ts"
import * as Keys from "./SessionKeys.ts"

const keys = await Effect.runPromise(Keys.make(Redacted.make("anonymous-test-signing-secret".padEnd(64, "7"))))

test.each(["cookie", "bearer", "both"])("an anonymous %s request resolves neither proof, even when its auth service fails", async kind => {
  const credentials = Credentials.make({ keys, person: () => Effect.die(new Error("Anonymous requests must not resolve a person")) })
  const token = await Effect.runPromise(credentials.sign({ v: 1, sub: "person-Q", sid: "session-Q", act: "agent", run: "run-Q", root: "run-Q", chain: ["chat/Answer"], ceiling: [], exp: Date.now() + 60 * 60 * 1000 }))
  const request = HttpServerRequest.fromWeb(new Request("https://smithers.test/api/private", { headers: {
    [DEVICE_PERSON_HEADER]: "@anonymous",
    ...(kind === "bearer" ? {} : { cookie: "smithers_session=present" }),
    ...(kind === "cookie" ? {} : { authorization: `Bearer ${token}` }),
  } }))
  const registry: Metric.MetricRegistry = new Map()
  const session = Effect.die(new Error("Anonymous requests must not resolve a cookie"))
  for (const effect of [Credentials.resolveWith(credentials, session), Credentials.resolveCookieWith(session)]) {
    expect(await Effect.runPromise(effect.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(Metric.MetricRegistry, registry),
    ))).toEqual(Option.none())
  }
  const snapshot = await Effect.runPromise(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)))
  const refused = snapshot.filter(entry => entry.id === "smithers_device_principal_refusals")
  expect(refused.map(entry => entry.attributes?.outcome)).toEqual(["anonymous"])
  expect((refused[0]!.state as { count: number }).count).toBe(2)
  expect(snapshot.some(entry => entry.id === "smithers_run_credentials")).toBe(false)
})
