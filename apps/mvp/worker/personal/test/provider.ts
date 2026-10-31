// A person's model provider for the tests, scripted at the network: an OpenAI-compatible Chat Completions endpoint at
// `https://models.example.com` and an Anthropic-compatible Messages endpoint at `https://anthropic.example.com`,
// reached through an injected `FetchHttpClient.Fetch`, as ChatApi's own fetch would reach a real one. Any other address
// goes to `passthrough` (the compose Electric, for one). The provider is the only scripted seam: the model package's
// real routes build, sign and read every request.

/** The OpenAI-compatible provider's origin. */
export const OPENAI_ORIGIN = "https://models.example.com"

/** OpenAI's own API, whose reasoning models a person's OpenAI-compatible key reaches through the Responses API. */
export const OPENAI_API_ORIGIN = "https://api.openai.com"

/** The Anthropic-compatible provider's origin. */
export const ANTHROPIC_ORIGIN = "https://anthropic.example.com"

/** What the provider answers one request with: words, or an error status with the provider's own error body. */
export interface Reply {
  readonly text?: string
  readonly status?: number
  readonly error?: { readonly type?: string; readonly code?: string; readonly message?: string }
  readonly usage?: { readonly input: number; readonly output: number }
  /** Never answers until the request is aborted. */
  readonly hang?: boolean
}

/** One request the provider saw: where it went, its headers and its JSON body. */
export interface Seen {
  readonly url: string
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

/** OpenAI's auth server, as `CODEX_AUTH_ORIGIN` points a test at it. */
export const CODEX_AUTH_ORIGIN = "https://auth.example.com"

/** The credential's tokens a scripted OpenAI hands out: none occurs in any other test text. */
export const CODEX_ACCESS = "SENTINEL-codex-access-token"
export const CODEX_REFRESH = "SENTINEL-codex-refresh-token"

/** A JWT of `claims`, unsigned, as an id token's payload reads. */
export const idToken = (claims: { readonly accountId: string; readonly planType: string }) =>
  ["e30", btoa(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: claims.accountId, chatgpt_plan_type: claims.planType },
  })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), "SENTINEL-codex-id-signature"].join(".")

/** One request OpenAI's auth server saw: its path, and its body as JSON or a form's fields. */
export interface AuthSeen {
  readonly path: string
  readonly body: Record<string, string>
}

/**
 * OpenAI's auth server at {@link CODEX_AUTH_ORIGIN}, scripted: each path answers what `script` says, by how many came
 * to it before. Unscripted, the code is answered, the poll is pending and the token endpoint refuses. Any other address
 * goes to `passthrough`.
 */
export const scriptedOpenAi = (
  script: (path: string, index: number, body: Record<string, string>) => { readonly status: number; readonly body?: unknown } | string | undefined,
  passthrough: typeof globalThis.fetch = globalThis.fetch,
) => {
  const seen: Array<AuthSeen> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.origin !== CODEX_AUTH_ORIGIN) return passthrough(input, init)
    const text = await request.text()
    const body = (request.headers.get("content-type") ?? "").includes("json")
      ? JSON.parse(text) as Record<string, string>
      : Object.fromEntries(new URLSearchParams(text))
    const index = seen.filter((each) => each.path === url.pathname).length
    seen.push({ path: url.pathname, body })
    const answer = script(url.pathname, index, body)
    if (typeof answer === "string") return new Response(answer, { status: 200 })
    if (answer !== undefined) return Response.json(answer.body ?? {}, { status: answer.status })
    return url.pathname.endsWith("/usercode")
      ? Response.json({ device_auth_id: "device-1", user_code: "ABCD-EFGH", interval: "5" })
      : new Response("{}", { status: url.pathname.endsWith("/deviceauth/token") ? 403 : 400 })
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

/** Vercel's AI Gateway's Jev endpoint. */
export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"

/** One request the gateway saw. */
export interface GatewaySeen {
  readonly headers: Headers
  readonly body: Record<string, unknown>
}

/** Vercel's gateway, scripted: `answer` is each request's status and body. Any other address goes to `passthrough`. */
export const scriptedGateway = (
  answer: (index: number) => { readonly status: number; readonly body: unknown },
  passthrough: typeof globalThis.fetch = globalThis.fetch,
) => {
  const seen: Array<GatewaySeen> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url !== GATEWAY_URL) return passthrough(input, init)
    const index = seen.length
    seen.push({ headers: request.headers, body: await request.json() as Record<string, unknown> })
    const { status, body } = answer(index)
    return Response.json(body, { status })
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

const sse = (events: ReadonlyArray<unknown>, named = false) =>
  events.map((event) =>
    named ? `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n` : `data: ${JSON.stringify(event)}\n\n`
  ).join("") + (named ? "" : "data: [DONE]\n\n")

const openAiStream = (text: string, usage: { readonly input: number; readonly output: number }) =>
  sse([
    { id: "c1", choices: [{ index: 0, delta: { content: text } }] },
    { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: "c1", choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } },
  ])

/** OpenAI's Responses API stream, which api.openai.com's reasoning models answer through (worker/personal/Models.ts). */
const responsesStream = (text: string, usage: { readonly input: number; readonly output: number }) =>
  sse([
    { type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: text },
    { type: "response.completed", response: { id: "r1", status: "completed", usage: { input_tokens: usage.input, output_tokens: usage.output } } },
  ], true)

const anthropicStream = (text: string, usage: { readonly input: number; readonly output: number }) =>
  sse([
    {
      type: "message_start",
      message: { id: "m1", type: "message", role: "assistant", content: [], model: "m", usage: { input_tokens: usage.input, output_tokens: 0 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output } },
    { type: "message_stop" },
  ], true)

/**
 * The scripted providers at `origins` (an Anthropic-compatible one at {@link ANTHROPIC_ORIGIN}, OpenAI-compatible ones
 * at the rest): `reply` answers each request (a function sees how many came before, and the request's body), `seen`
 * records them.
 */
export const scriptedProvider = (
  reply: Reply | ((index: number, body: Record<string, unknown>) => Reply),
  passthrough: typeof globalThis.fetch = globalThis.fetch,
  origins: ReadonlyArray<string> = [OPENAI_ORIGIN, ANTHROPIC_ORIGIN],
) => {
  const seen: Array<Seen> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (!origins.includes(url.origin)) return passthrough(input, init)
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    const index = seen.length
    seen.push({ url: request.url, headers: request.headers, body })
    const answer = typeof reply === "function" ? reply(index, body) : reply
    if (answer.hang === true) {
      return new Promise<Response>((_, reject) =>
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })
      )
    }
    if (answer.status !== undefined) {
      return new Response(JSON.stringify({ error: answer.error ?? { message: "refused" } }), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      })
    }
    const usage = answer.usage ?? { input: 3, output: 2 }
    return new Response(
      url.origin === ANTHROPIC_ORIGIN
        ? anthropicStream(answer.text ?? "ok", usage)
        : url.pathname.endsWith("/responses")
        ? responsesStream(answer.text ?? "ok", usage)
        : openAiStream(answer.text ?? "ok", usage),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  }) as typeof globalThis.fetch
  return { fetch, seen }
}
