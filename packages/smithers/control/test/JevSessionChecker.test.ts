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

const report = (checker: Health.HealthChecker, probeContext: Health.ProbeContext) =>
  Effect.runPromise(Health.evaluate(resolved(checker), probeContext, stamp)).then((observation) => observation.report)

describe("Jev session checker", () => {
  it("answers the lifecycle result without calling the gateway when no key is configured", async () => {
    const fetch = answering(decided("needs-input", 0.99))
    const checker = JevSessionChecker.makeJevSessionChecker({ env: {}, fetch })
    expect(await report(checker, context(prompt))).toEqual({ activity: "unknown", reason: "ok" })
    expect(fetch).not.toHaveBeenCalled()
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

  it("refuses a choice the gateway reported no confidence for", async () => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: answering({ answers: { activity: { type: "choice", choice: "needs-input" } } })
    })
    expect(await report(checker, context(prompt))).toEqual({ activity: "unknown", reason: "ok" })
  })

  it("refuses an option the questions never offered", async () => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: answering(decided("rebooting", 0.99))
    })
    expect(await report(checker, context(prompt))).toEqual({ activity: "unknown", reason: "ok" })
  })

  it.each([401, 403, 429, 500])("degrades a %d refusal to the lifecycle result", async (status) => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: answering({ error: "refused" }, { status })
    })
    expect(await report(checker, context(prompt))).toEqual({ activity: "unknown", reason: "ok" })
  })

  it.each([
    ["a transport failure", () => Promise.reject(new Error("socket hang up"))],
    ["an unreadable body", () => Promise.resolve(new Response("<html>gateway</html>", { status: 200 }))],
    ["an answer for no question asked", () => Promise.resolve(new Response(JSON.stringify({ answers: {} })))]
  ])("degrades %s to the lifecycle result", async (_name, transport) => {
    const checker = JevSessionChecker.makeJevSessionChecker({
      env: key,
      fetch: vi.fn<typeof globalThis.fetch>(transport)
    })
    expect(await report(checker, context(prompt))).toEqual({ activity: "unknown", reason: "ok" })
  })

  it("abandons a gateway that never answers, without failing the probe", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })
    )
    const checker = JevSessionChecker.makeJevSessionChecker({ env: key, fetch, timeoutMs: 10 })
    expect(await report(checker, context(prompt))).toEqual({ activity: "unknown", reason: "ok" })
    expect(fetch).toHaveBeenCalledTimes(1)
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

  it("never sends the key or the terminal tail to a host that did not configure one", async () => {
    const fetch = answering(decided("working", 0.9))
    const checker = JevSessionChecker.makeJevSessionChecker({ env: { OTHER: "gateway-key" }, fetch })
    expect(await report(checker, context(prompt))).toEqual({ activity: "unknown", reason: "ok" })
    expect(fetch).not.toHaveBeenCalled()
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

  it("leaves the probe budget above the request deadline so its own abort is what degrades", () => {
    expect(JevSessionChecker.jevSessionChecker.defaults?.timeoutMs).toBeGreaterThan(
      JevSessionChecker.jevRequestTimeoutMs
    )
  })
})

/** 0.69 rounds to Jev's two probability decimals and still sits under the floor. */
function jevJustUnderTheFloor(): number {
  return JevSessionChecker.jevConfidenceFloor - 0.01
}
