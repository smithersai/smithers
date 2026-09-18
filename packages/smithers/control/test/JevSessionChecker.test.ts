import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as Health from "../src/Health.ts"
import * as JevSessionChecker from "../src/JevSessionChecker.ts"

const stamp = { monitorId: "host-one", incarnation: "owner-one", evidenceSeq: 4 }
const key = { AI_GATEWAY_API_KEY: "gateway-key" }
const prompt = "Applying 0003_add_indexes.sql\nShould I proceed with the migration? (y/n) "

const context = (outputTail: string | undefined, alive = true): Health.ProbeContext => ({
  subjectId: "session:one",
  state: alive ? "running" : "exited",
  events: [],
  sinceCursor: 0,
  session: { alive, exitCode: alive ? null : 0, outputCursor: 12, ...(outputTail === undefined ? {} : { outputTail }) }
})

/** The checker as a host would run it: through `Health.evaluate`, at the default policy. */
const resolved = (checker: Health.HealthChecker): Health.ResolvedCheck => ({
  checker,
  config: undefined,
  policy: Health.defaultPolicy,
  exposeOutput: true
})

const answering = (
  body: unknown,
  init: ResponseInit = {}
): typeof globalThis.fetch =>
  vi.fn<typeof globalThis.fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200, ...init })))

const decided = (activity: string, confidence: number, waiting = 0.9) => ({
  answers: {
    activity: { type: "choice", choice: activity, probabilities: { [activity]: confidence } },
    question: { type: "boolean", probability: waiting }
  },
  providerMetadata: { typesafe: { confidence: { activity: confidence, question: waiting } } }
})

const observe = (checker: Health.HealthChecker, probeContext: Health.ProbeContext) =>
  Effect.runPromise(Health.evaluate(resolved(checker), probeContext, stamp))

const report = (checker: Health.HealthChecker, probeContext: Health.ProbeContext) =>
  observe(checker, probeContext).then((observation) => observation.report)

/** The typed failure the probe raised, read before `Health.evaluate` erases it. */
const refusal = (checker: Health.HealthChecker, probeContext: Health.ProbeContext) =>
  Effect.runPromise(Effect.flip(checker.probe(probeContext, undefined)))

/** What a status surface renders for this subject after one observation. */
const subject = async (checker: Health.HealthChecker, probeContext: Health.ProbeContext) => {
  const observation = await observe(checker, probeContext)
  return Health.rollup({
    subjectId: probeContext.subjectId,
    state: probeContext.state,
    incarnation: stamp.incarnation,
    latest: { observation, sequence: 1 },
    now: observation.observedAt,
    updatedAt: observation.observedAt
  })
}

const rejecting = (transport: typeof globalThis.fetch): typeof globalThis.fetch =>
  vi.fn<typeof globalThis.fetch>(transport)

describe("Jev session checker", () => {
  it("fails the probe without calling the gateway when no key is configured", async () => {
    const fetch = answering(decided("needs-input", 0.99))
    const checker = JevSessionChecker.makeJevSessionChecker({ env: {}, fetch })
    expect(await refusal(checker, context(prompt))).toMatchObject({
      _tag: "JevProbeError",
      reason: "unconfigured"
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("never sends the key or the terminal tail to a host that did not configure one", async () => {
    const fetch = answering(decided("working", 0.9))
    const checker = JevSessionChecker.makeJevSessionChecker({ env: { OTHER: "gateway-key" }, fetch })
    expect(await refusal(checker, context(prompt))).toMatchObject({ reason: "unconfigured" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("fails the probe when the configured key is empty", async () => {
    const fetch = answering(decided("working", 0.9))
    const checker = JevSessionChecker.makeJevSessionChecker({ env: { AI_GATEWAY_API_KEY: "" }, fetch })
    expect(await refusal(checker, context(prompt))).toMatchObject({ reason: "unconfigured" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([401, 403, 429, 500])("fails the probe on a %d refusal, carrying the status", async (status) => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: answering({ error: "refused" }, { status })
    })
    expect(await refusal(checker, context(prompt))).toMatchObject({ reason: "http", status })
  })

  it("fails the probe when the socket dies", async () => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: rejecting(() => Promise.reject(new Error("socket hang up")))
    })
    expect(await refusal(checker, context(prompt))).toMatchObject({ reason: "unreachable" })
  })

  it("fails the probe when the gateway never answers, and asks only once", async () => {
    const fetch = rejecting((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })
    )
    const checker = JevSessionChecker.makeJevSessionChecker({ env: key, fetch, timeoutMs: 10 })
    expect(await refusal(checker, context(prompt))).toMatchObject({ reason: "timeout" })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["the body is not JSON", () => Promise.resolve(new Response("<html>gateway</html>", { status: 200 }))],
    ["no question was answered", () => Promise.resolve(new Response(JSON.stringify({ answers: {} })))],
    [
      "the answer is not a choice",
      () => Promise.resolve(new Response(JSON.stringify({ answers: { activity: { type: "boolean" } } })))
    ],
    [
      "the choice is not a string",
      () => Promise.resolve(new Response(JSON.stringify({ answers: { activity: { type: "choice", choice: 7 } } })))
    ]
  ])("fails the probe when %s", async (_name, transport) => {
    const checker = JevSessionChecker.makeJevSessionChecker({ env: key, fetch: rejecting(transport) })
    expect(await refusal(checker, context(prompt))).toMatchObject({ reason: "malformed" })
  })

  it("fails the probe on an option the questions never offered", async () => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: answering(decided("rebooting", 0.99))
    })
    expect(await refusal(checker, context(prompt))).toMatchObject({ reason: "malformed" })
  })

  it.each([
    ["no key is configured", JevSessionChecker.makeJevSessionChecker({ env: {} })],
    [
      "the gateway refuses",
      JevSessionChecker.makeJevSessionChecker({ env: key, fetch: answering({ error: "refused" }, { status: 403 }) })
    ],
    [
      "the socket dies",
      JevSessionChecker.makeJevSessionChecker({
        env: key,
        fetch: rejecting(() => Promise.reject(new Error("socket hang up")))
      })
    ],
    [
      "the body is unreadable",
      JevSessionChecker.makeJevSessionChecker({
        env: key,
        fetch: rejecting(() => Promise.resolve(new Response("<html>gateway</html>")))
      })
    ]
  ])("reads probe-error, never healthy, when %s", async (_name, checker) => {
    const observation = await observe(checker, context(prompt))
    expect(observation).toMatchObject({ outcome: "error", reason: "probe-error" })
    expect(observation.report).toBeUndefined()
    expect(await subject(checker, context(prompt))).toMatchObject({
      activity: "unknown",
      health: "unknown",
      freshness: "stale",
      reason: "probe-error"
    })
  })

  it.each([
    ["no output tail is exposed", context(undefined)],
    ["the tail is empty", context("")],
    ["the session has exited", context(prompt, false)]
  ])("answers the lifecycle result without calling the gateway when %s", async (_name, probeContext) => {
    const fetch = answering(decided("needs-input", 0.99))
    const checker = JevSessionChecker.makeJevSessionChecker({ env: key, fetch })
    expect(await report(checker, probeContext)).toEqual({ activity: "unknown", reason: "ok" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reports a person-blocking prompt when Jev is confident", async () => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: answering(decided("needs-input", 0.93))
    })
    expect(await report(checker, context(prompt))).toEqual({ activity: "needs-input", reason: "prompt-detected" })
  })

  it.each(["working", "idle"] as const)("reports %s when Jev is confident", async (activity) => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: answering(decided(activity, 0.88, 0.02))
    })
    expect(await report(checker, context(prompt))).toEqual({ activity, reason: "ok" })
  })

  it.each([
    ["needs-input", 0.4],
    ["working", 0.4],
    ["idle", jevJustUnderTheFloor()]
  ])("refuses to turn a %j answer at confidence %d into a signal", async (activity, confidence) => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: answering(decided(activity, confidence))
    })
    expect(await report(checker, context(prompt))).toEqual({ activity: "unknown", reason: "ok" })
  })

  it("treats a choice the gateway reported no confidence for as an answer below the floor", async () => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: answering({ answers: { activity: { type: "choice", choice: "needs-input" } } })
    })
    expect(await report(checker, context(prompt))).toEqual({ activity: "unknown", reason: "ok" })
  })

  it("sends one zero-retention evaluation carrying the clipped tail and both questions", async () => {
    const fetch = answering(decided("working", 0.9, 0.05))
    const checker = JevSessionChecker.makeJevSessionChecker({ env: key, fetch })
    const noise = `${"x".repeat(JevSessionChecker.jevStateTailCharacters * 2)}${prompt}`
    await report(checker, context(noise))

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe(JevSessionChecker.jevEvaluationUrl)
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({
      authorization: "Bearer gateway-key",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": JevSessionChecker.jevModelId,
      "content-type": "application/json"
    })
    expect(JevSessionChecker.jevModelId).toBe("typesafe-ai/jev")

    const body = JSON.parse(String(init.body)) as {
      state: { alive: boolean; exitCode: number | null; outputTail: string }
      questions: Record<string, { type: string; criteria?: unknown }>
      providerOptions: { gateway: { zeroDataRetention: boolean } }
    }
    expect(body.providerOptions.gateway.zeroDataRetention).toBe(true)
    expect(body.state).toMatchObject({ alive: true, exitCode: null })
    expect(body.state.outputTail).toHaveLength(JevSessionChecker.jevStateTailCharacters)
    // The newest bytes are what a waiting prompt lives in, so the clip keeps the end.
    expect(body.state.outputTail.endsWith(prompt)).toBe(true)
    expect(body.questions["activity"]?.type).toBe("choice")
    expect(Object.keys(body.questions["activity"]?.criteria as object)).toEqual(["working", "idle", "needs-input"])
    expect(body.questions["question"]?.type).toBe("boolean")
  })

  it("reads the host's own key, gateway and deadline when nothing is injected", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "ambient-key")
    const ambient = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(JSON.stringify(decided("needs-input", 0.95))))
    )
    vi.stubGlobal("fetch", ambient)
    try {
      expect(await report(JevSessionChecker.jevSessionChecker, context(prompt))).toEqual({
        activity: "needs-input",
        reason: "prompt-detected"
      })
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
    const [url, init] = ambient.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(JevSessionChecker.jevEvaluationUrl)
    expect(init.headers).toMatchObject({ authorization: "Bearer ambient-key" })
    expect(init.signal?.aborted).toBe(false)
  })

  it("is bindable by id and changes nothing for a host that does not bind it", () => {
    const registry = Health.makeRegistry({ bindings: { review: { checkerId: "jev.session" } } }, "session")
    expect(registry.resolve("review").checker.id).toBe("jev.session")
    expect(registry.resolve("anything-else").checker.id).toBe("lifecycle.session")
    expect(Health.makeRegistry({}, "run").resolve("anything").checker.id).toBe("lifecycle.run")
  })

  it("leaves the probe budget above the request deadline so the typed failure is what surfaces", () => {
    expect(JevSessionChecker.jevSessionChecker.defaults?.timeoutMs).toBeGreaterThan(
      JevSessionChecker.jevRequestTimeoutMs
    )
  })
})

/** 0.69 rounds to Jev's two probability decimals and still sits under the floor. */
function jevJustUnderTheFloor(): number {
  return JevSessionChecker.jevConfidenceFloor - 0.01
}
