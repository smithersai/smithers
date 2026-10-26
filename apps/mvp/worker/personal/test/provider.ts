// A person's model provider for the tests, scripted at the network: an OpenAI-compatible Chat Completions endpoint at
// `https://models.example.com` and an Anthropic-compatible Messages endpoint at `https://anthropic.example.com`,
// reached through an injected `FetchHttpClient.Fetch`, as ChatApi's own fetch would reach a real one. Any other address
// goes to `passthrough` (the compose Electric, for one). The provider is the only scripted seam: the model package's
// real routes build, sign and read every request.

/** The OpenAI-compatible provider's origin. */
export const OPENAI_ORIGIN = "https://models.example.com"

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
      url.origin === ANTHROPIC_ORIGIN ? anthropicStream(answer.text ?? "ok", usage) : openAiStream(answer.text ?? "ok", usage),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  }) as typeof globalThis.fetch
  return { fetch, seen }
}
