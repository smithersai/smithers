import { Author, Catalog, Chain, Journal, ScriptRunner } from "@smthrs/chain"
import type { Outcome } from "@smthrs/chain"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { MODEL_STREAM_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { DEFAULT_MODEL_ID, layerAuthor } from "./StreamModel"

/*
 * The relay seat, proven over a recorded upstream stream: the real
 * @smthrs/model machinery (NDJSON framing, frame decode, settle fold) runs
 * against a fixture response served by an injected fetch — no network, no mocks
 * below the fetch seam. The fixture frames are the chat Worker's own contract,
 * which is what the relay forwards verbatim.
 */

const ndjsonOf = (frames: ReadonlyArray<Record<string, unknown>>): string =>
  `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`

const textTurn = (chunks: ReadonlyArray<string>): string =>
  ndjsonOf([
    { type: "delta", kind: "reasoning", text: "thinking…" },
    ...chunks.map((text) => ({ type: "delta", kind: "text", text })),
    { type: "done", reason: "stop" }
  ])

const fixtureFetch = (
  streams: ReadonlyArray<string>
): { readonly fetchImpl: FetchLike; readonly requests: Array<Request> } => {
  const requests: Array<Request> = []
  const fetchImpl: FetchLike = async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    const body = streams[requests.length - 1] ?? streams[streams.length - 1] ?? ""
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" }
    })
  }
  return { fetchImpl, requests }
}

const authorOnce = (fetchImpl: FetchLike): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const author = yield* Author.Author
      return yield* author.author({ prefix: "You are Smithers.", context: ["ctx line"] })
    }).pipe(
      Effect.provide(layerAuthor({ baseUrl: "https://app.test", fetchImpl }))
    ) as Effect.Effect<string, never, never>
  )

describe("the relay author seat", () => {
  test("authors from a recorded upstream stream through the Worker relay path", async () => {
    const { fetchImpl, requests } = fixtureFetch([textTurn(["Hello", ", world"])])
    expect(await authorOnce(fetchImpl)).toBe("Hello, world")

    expect(requests).toHaveLength(1)
    const sent = requests[0]!
    expect(sent.method).toBe("POST")
    expect(new URL(sent.url).origin).toBe("https://app.test")
    expect(new URL(sent.url).pathname).toBe(MODEL_STREAM_PATH)
    const body = (await sent.json()) as {
      readonly instructions?: string
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>
      readonly tools?: ReadonlyArray<unknown>
    }
    expect(body.instructions).toBe("You are Smithers.")
    expect(body.messages).toEqual([{ role: "user", content: "ctx line" }])
    // The sealed-step law rides the wire: the author call carries no tools.
    expect(body.tools).toBeUndefined()
    // No credential exists on this side: the session cookie is the only one.
    expect(sent.headers.get("authorization")).toBeNull()
    expect(sent.headers.get("x-api-key")).toBeNull()
  })

  test("the seat names the model the relay actually serves", () => {
    expect(DEFAULT_MODEL_ID).toBe("gpt-oss-120b")
  })

  test("an unfinished turn is not an authored answer", async () => {
    // `tool_limit` means the upstream refused another leg: the answer is
    // truncated, and a truncated answer must never pass as a complete one.
    const { fetchImpl } = fixtureFetch([
      ndjsonOf([{ type: "delta", kind: "text", text: "half" }, { type: "done", reason: "tool_limit" }])
    ])
    const failure = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function*() {
          const author = yield* Author.Author
          return yield* author.author({ prefix: "p", context: ["c"] })
        }).pipe(Effect.provide(layerAuthor({ baseUrl: "https://app.test", fetchImpl }))) as Effect.Effect<
          string,
          unknown,
          never
        >
      )
    )
    expect(failure._tag).toBe("Failure")
  })

  test("a chain runs a turn end-to-end over the relay seat", async () => {
    const script = ["```flow", `const noted = await ctx.call("probe", {})`, `return done({ noted })`, "```"].join("\n")
    const { fetchImpl } = fixtureFetch([textTurn([script.slice(0, 20), script.slice(20)])])
    let probed = 0
    const probe: Catalog.Entry = {
      name: "probe",
      description: "test probe",
      handler: () =>
        Effect.sync(() => {
          probed += 1
          return { ok: true }
        })
    }
    const outcome = await Effect.runPromise(
      Chain.run({ goal: "probe the app" }).pipe(
        Effect.provide(
          (() => {
            const base = Layer.mergeAll(
              Journal.layerMemory([]),
              layerAuthor({ baseUrl: "https://app.test", fetchImpl }),
              ScriptRunner.layerInProcess
            )
            return Layer.mergeAll(base, Catalog.layer([probe]).pipe(Layer.provide(base)))
          })()
        )
      ) as Effect.Effect<Outcome.Terminal, never, never>
    )
    expect(outcome._tag).toBe("Done")
    expect(probed).toBe(1)
  })
})
