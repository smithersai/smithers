/**
 * Supported Host probes and unsupported failures without a discoverable code.
 *
 * The ordinary TestHost profile intentionally declares Jj and HTTP
 * unsupported. These focused bundles drive the other half of those contracts,
 * including the report shape when a provider fails without any stable code.
 */
import * as Jj from "@smthrs/jj"
import * as TestHost from "@smthrs/testing/TestHost"
import { Clock, Effect, Layer, Random } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as ChildProcess from "effect/process/ChildProcess"
import { describe, expect, it } from "vitest"
import * as HostSuite from "../../src/HostSuite.ts"
import { CapabilityContractError } from "../../src/TestingError.vibe"

const profile: HostSuite.HostProfile = {
  fileSystem: { supported: true },
  path: { supported: true },
  shell: { supported: true, interruptCommand: ChildProcess.make("host-suite-pending") },
  jj: { supported: false, code: "not_installed" },
  httpTransport: { supported: false, code: "TransportError" },
  clock: { supported: true },
  random: { supported: true }
}

const replaceJj = (status: Jj.Jj["status"]): HostSuite.HostBundle =>
  Layer.merge(
    TestHost.TestHost,
    Layer.succeed(Jj.Jj)(Jj.makeNoop({ status }))
  ) as HostSuite.HostBundle

const replaceHttp = (status: number): HostSuite.HostBundle =>
  Layer.merge(
    TestHost.TestHost,
    Layer.succeed(HttpClient.HttpClient)(
      HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))))
    )
  ) as HostSuite.HostBundle

const invalidClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Number.NaN,
  currentTimeMillis: Effect.succeed(Number.NaN),
  currentTimeNanosUnsafe: () => 0n,
  currentTimeNanos: Effect.succeed(0n),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.succeed(0n),
  sleep: () => Effect.void
}

const invalidRandom: typeof Random.Random.Service = {
  nextIntUnsafe: () => 2,
  nextDoubleUnsafe: () => 2
}

const invalidClockAndRandom = Layer.merge(
  TestHost.TestHost,
  Layer.mergeAll(
    Layer.succeed(Clock.Clock)(invalidClock),
    Layer.succeed(Random.Random)(invalidRandom)
  )
) as HostSuite.HostBundle

const named = (bundle: HostSuite.HostBundle, declared: HostSuite.HostProfile, name: string) =>
  HostSuite.hostSuite(bundle, declared).find((suiteCase) => suiteCase.name === name)!

const failureOf = (suiteCase: HostSuite.HostSuiteCase) => Effect.runPromise(Effect.flip(suiteCase.run))

describe("HostSuite supported capability probes", () => {
  it("accepts a string Jj status and rejects a malformed one", async () => {
    const supported = { ...profile, jj: { supported: true } as const }
    await expect(
      Effect.runPromise(
        named(replaceJj(() => Effect.succeed("clean")), supported, "Jj has a declared capability result").run
      )
    ).resolves.toBeUndefined()

    const malformed = await failureOf(
      named(
        replaceJj(() => Effect.succeed(42 as never)),
        supported,
        "Jj has a declared capability result"
      )
    )
    expect(malformed).toMatchObject({
      code: "capability_contract_violation",
      capability: "Jj",
      operation: "status"
    })
  })

  it("accepts the declared HTTP status and reports a different one", async () => {
    const request = HttpClientRequest.get("https://host-suite.test/status")
    const supported = {
      ...profile,
      httpTransport: { supported: true, request, expectedStatus: 204 } as const
    }
    await expect(
      Effect.runPromise(
        named(replaceHttp(204), supported, "HttpTransport has a declared capability result").run
      )
    ).resolves.toBeUndefined()

    const mismatch = await failureOf(
      named(
        replaceHttp(204),
        { ...supported, httpTransport: { supported: true, request, expectedStatus: 200 } },
        "HttpTransport has a declared capability result"
      )
    )
    expect(mismatch).toMatchObject({
      code: "capability_contract_violation",
      capability: "HttpTransport",
      operation: "execute"
    })
  })

  it("rejects invalid clock and random observations", async () => {
    const clock = await failureOf(named(invalidClockAndRandom, profile, "Clock is monotonic"))
    expect(clock).toMatchObject({
      code: "capability_contract_violation",
      capability: "Clock",
      operation: "currentTimeMillis"
    })

    const random = await failureOf(named(invalidClockAndRandom, profile, "Random produces a valid value"))
    expect(random).toMatchObject({
      code: "capability_contract_violation",
      capability: "Random",
      operation: "next"
    })
  })
})

describe("HostSuite unsupported capability diagnostics", () => {
  it("omits actualCode when the observed failure carries none", async () => {
    const bundle = replaceJj(() => Effect.fail("plain failure" as never))
    const error = await failureOf(named(bundle, profile, "Jj has a declared capability result"))
    expect(error).toMatchObject({
      code: "capability_contract_violation",
      capability: "Jj",
      operation: "status",
      expectedCode: "not_installed"
    })
    expect((error as CapabilityContractError).actualCode).toBeUndefined()
  })
})
