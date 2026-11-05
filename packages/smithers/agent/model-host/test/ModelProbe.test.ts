import type { ConfiguredModel } from "@smthrs/rpc"
import { Deferred, Effect, Fiber, Redacted } from "effect"
import { describe, expect, test, vi } from "vitest"
import type { ModelCredentials } from "../src/LocalModel.ts"
import { createModelProbe, type ModelProbeOptions } from "./fixtures/durable.ts"

/** The probe as a host's boundary runs it: each Test settled as a Promise. */
const runnableProbe = (options: ModelProbeOptions) => {
  const probe = createModelProbe(options)
  return {
    catalog: probe.catalog,
    test: (...call: Parameters<typeof probe.test>) => Effect.runPromise(probe.test(...call))
  }
}

type Fetch = typeof globalThis.fetch
const fetchOf = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): Fetch =>
  Object.assign(impl, { preconnect() {} })

const KEY = "sk-probe-REDACTME-0123456789"
const ORIGIN = "http://127.0.0.1:9"
const env = { SMITHERS_MODEL_KEY_LAB: KEY, SMITHERS_MODEL_KEY_LAB_ORIGIN: ORIGIN }
const generator: ConfiguredModel.ConfiguredModel = {
  id: "lab",
  protocol: "openai-chat",
  baseUrl: ORIGIN,
  modelId: "lab",
  credential: "LAB"
}
const decider: ConfiguredModel.ConfiguredModel = {
  id: "judge",
  protocol: "evaluation",
  baseUrl: ORIGIN,
  modelId: "judge",
  credential: "LAB"
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${
    JSON.stringify({
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "lab",
      choices: [{ index: 0, delta, finish_reason: finish }]
    })
  }\n\n`
const sse = (...frames: ReadonlyArray<string>) =>
  fetchOf(async () => new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } }))
const answering = (body: unknown) => fetchOf(async () => Response.json(body))

const probe = (fetch: Fetch, deadlineMs?: number) =>
  runnableProbe({ env, egress: false, fetch, ...(deadlineMs === undefined ? {} : { deadlineMs }) })

describe("a generation Test", () => {
  test("passes with the generated words, the credential cut out", async () => {
    const fetch = vi.fn<Fetch>(
      sse(chunk({ content: `hello ${KEY}` }), chunk({}, "stop"), "data: [DONE]\n\n")
    )
    const result = await probe(fetch).test(generator)
    expect(result).toMatchObject({ ok: true, output: { kind: "generation", text: "hello " } })
    expect(JSON.stringify(result)).not.toContain(KEY)
    const body = JSON.parse(new TextDecoder().decode(fetch.mock.calls[0]?.[1]?.body as Uint8Array)) as Record<
      string,
      unknown
    >
    expect(body).not.toHaveProperty("temperature")
  })

  test("sends a composed system prompt and temperature", async () => {
    const fetch = vi.fn<Fetch>(sse(chunk({ content: "ok" }), chunk({}, "stop"), "data: [DONE]\n\n"))
    const input: ConfiguredModel.ModelCallInput = {
      kind: "generation",
      system: "be brief",
      prompt: "hi",
      maxTokens: 8,
      temperature: 0.5
    }
    expect(await probe(fetch).test(generator, input)).toMatchObject({ ok: true, output: { text: "ok" } })
    const body = JSON.parse(new TextDecoder().decode(fetch.mock.calls[0]?.[1]?.body as Uint8Array)) as {
      messages: ReadonlyArray<{ role: string }>
      temperature: number
    }
    expect(body.messages[0]?.role).toBe("system")
    expect(body.temperature).toBe(0.5)
  })

  test("a stream that never settles is a protocol mismatch", async () => {
    expect(await probe(sse(chunk({ content: "partial" }))).test(generator)).toMatchObject({
      ok: false,
      failure: { code: "invalid", field: "protocol" }
    })
  })

  test("refuses a redirect instead of following it", async () => {
    const fetch = fetchOf(async () =>
      new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } })
    )
    expect(await probe(fetch).test(generator)).toMatchObject({ ok: false, failure: { code: "refused", status: 307 } })
  })

  test("times out at its one deadline", async () => {
    const fetch =
      (async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })) as typeof globalThis.fetch
    expect(await probe(fetch, 20).test(generator)).toMatchObject({
      ok: false,
      failure: { code: "timeout", deadlineMs: 20 }
    })
  })

  test("maps a provider refusal to its status", async () => {
    const fetch = fetchOf(async () => Response.json({ error: { message: "no" } }, { status: 401 }))
    expect(await probe(fetch).test(generator)).toMatchObject({ ok: false, failure: { code: "refused", status: 401 } })
  })
})

describe("a decision Test", () => {
  test("passes with the classifier's typed answers", async () => {
    const result = await probe(answering({ answers: { ok: { type: "boolean", probability: 0.9 } } })).test(decider)
    expect(result).toMatchObject({
      ok: true,
      output: { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: 0.9 } } }
    })
  })

  test("an answer the classifier refuses is a protocol mismatch", async () => {
    expect(await probe(answering({ answers: { ok: { type: "choice", choice: "a" } } })).test(decider)).toMatchObject({
      ok: false,
      failure: { code: "invalid", field: "protocol" }
    })
  })

  test("a defect is dropped as unreachable", async () => {
    const questions = new Proxy({}, {
      ownKeys: () => {
        throw new Error(KEY)
      }
    })
    const input = { kind: "decision", state: [], questions } as unknown as ConfiguredModel.ModelCallInput
    const result = await probe(answering({})).test(decider, input)
    expect(result).toMatchObject({ ok: false, failure: { code: "unreachable" } })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})

describe("before any call", () => {
  const never = fetchOf(async () => {
    throw new Error("dialed")
  })

  test("refuses a binding the planner refuses", async () => {
    expect(await probe(never).test({ ...generator, baseUrl: "https://elsewhere.test" })).toMatchObject({
      ok: false,
      failure: { code: "endpoint_forbidden" }
    })
  })

  test("names a missing credential", async () => {
    const result = await runnableProbe({
      env: { SMITHERS_MODEL_KEY_LAB_ORIGIN: ORIGIN },
      egress: false,
      fetch: never
    }).test(generator)
    expect(result).toMatchObject({ ok: false, failure: { code: "credential_missing", credential: "LAB" } })
  })

  test("refuses input of the other kind", async () => {
    const input: ConfiguredModel.ModelCallInput = { kind: "generation", system: "", prompt: "hi", maxTokens: 8 }
    expect(await probe(never).test(decider, input)).toMatchObject({
      ok: false,
      failure: { code: "invalid", field: "protocol" }
    })
  })
})

describe("stored credentials", () => {
  test("refresh before a Test and back the catalog", async () => {
    const rows: ReadonlyArray<ConfiguredModel.ModelCredentialListing> = [{
      name: "LAB",
      origins: [ORIGIN],
      present: true,
      managed: true
    }]
    const credentials: ModelCredentials = {
      refresh: vi.fn(() => Effect.void),
      list: () => rows,
      read: () => Redacted.make(KEY)
    }
    const host = runnableProbe({
      credentials,
      env: {},
      egress: true,
      fetch: sse(chunk({ content: "ok" }), chunk({}, "stop"), "data: [DONE]\n\n")
    })
    expect(await host.test(generator)).toMatchObject({ ok: true })
    expect(credentials.refresh).toHaveBeenCalledOnce()
    expect(host.catalog().credentials).toEqual(rows)
  })

  test("a credential store that throws answers unreachable instead of rejecting the Test", async () => {
    const rows: ReadonlyArray<ConfiguredModel.ModelCredentialListing> = [{
      name: "LAB",
      origins: [ORIGIN],
      present: true,
      managed: true
    }]
    const stores: ReadonlyArray<ModelCredentials> = [
      {
        refresh: () => Effect.fail(new Error(`keychain locked ${KEY}`)),
        list: () => rows,
        read: () => Redacted.make(KEY)
      },
      {
        refresh: () => Effect.void,
        list: () => rows,
        read: () => {
          throw new Error(`keychain locked ${KEY}`)
        }
      }
    ]
    for (const credentials of stores) {
      const fetch = vi.fn(sse(chunk({ content: "ok" }), chunk({}, "stop"), "data: [DONE]\n\n"))
      const host = runnableProbe({ credentials, env: {}, egress: true, fetch })
      const result = await host.test(generator)
      expect(result).toMatchObject({ ok: false, failure: { code: "unreachable" } })
      expect(JSON.stringify(result)).not.toContain(KEY)
      expect(fetch).not.toHaveBeenCalled()
    }
  })
})

test("ChatGPT Test uses subscription auth without inventing an output cap; explicit caps still refuse", async () => {
  const access = "private-subscription-token"
  const account = "private-subscription-account"
  const credential = JSON.stringify({ accessToken: access, accountId: account })
  const model: ConfiguredModel.ConfiguredModel = {
    id: "chatgpt",
    protocol: "openai-responses-chatgpt",
    modelId: "gpt-6-sol",
    credential: "CHATGPT_SUBSCRIPTION"
  }
  const fetch = vi.fn<Fetch>(fetchOf(async (url, init) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${access}`)
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(account)
    const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
    expect(body).not.toHaveProperty("max_output_tokens")
    return new Response(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: `hello ${access} ${account}` })}\n\ndata: ${
        JSON.stringify({
          type: "response.completed",
          response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } }
        })
      }\n\n`,
      { headers: { "content-type": "text/event-stream" } }
    )
  }))
  const tester = runnableProbe({ env: { CHATGPT_SUBSCRIPTION: credential }, egress: true, fetch })
  const result = await tester.test(model)
  expect(result.ok).toBe(true)
  expect(JSON.stringify(result)).not.toContain(access)
  expect(JSON.stringify(result)).not.toContain(account)
  expect(await tester.test(model, { kind: "generation", prompt: "hi", system: "", maxTokens: 8 })).toMatchObject({
    ok: false,
    failure: { code: "invalid", field: "protocol" }
  })
  expect(fetch).toHaveBeenCalledTimes(1)
})

// Inject a credential dependency with a typed failure and cooperative cancellation.
test("credential refresh maps typed failure without leaking it", async () => {
  const rows = [{ name: "LAB", origins: [ORIGIN], present: true, managed: true }]
  const result = await Effect.runPromise(
    createModelProbe({
      env: {},
      egress: true,
      credentials: {
        refresh: () => Effect.fail(new Error("private-keychain-error")),
        list: () => rows,
        read: () => Redacted.make(KEY)
      },
      fetch: sse(chunk({ content: "ok" }), chunk({}, "stop"), "data: [DONE]\n\n")
    }).test(generator)
  )
  expect(result).toMatchObject({ ok: false, failure: { code: "unreachable" } })
  expect(JSON.stringify(result)).not.toContain("private-keychain-error")
})

test("credential refresh is cancelled with its caller", async () => {
  const rows = [{ name: "LAB", origins: [ORIGIN], present: true, managed: true }]
  await Effect.runPromise(Effect.gen(function*() {
    const started = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const host = createModelProbe({
      env: {},
      egress: true,
      credentials: {
        refresh: () =>
          Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
            Effect.ensuring(Deferred.succeed(cancelled, undefined))
          ),
        list: () => rows,
        read: () => Redacted.make(KEY)
      }
    })
    const fiber = yield* Effect.forkChild(host.test(generator))
    // Race the start against completion so the old Promise contract fails without a timeout.
    const began = yield* Effect.raceFirst(
      Effect.as(Deferred.await(started), true),
      Effect.as(Fiber.await(fiber), false)
    )
    expect(began).toBe(true)
    yield* Fiber.interrupt(fiber)
    expect(yield* Deferred.isDone(cancelled)).toBe(true)
  }))
})
