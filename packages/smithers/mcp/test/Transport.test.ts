import { Effect, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as HttpTransport from "../src/internal/HttpTransport.ts"
import * as Transport from "../src/internal/Transport.ts"

const bytes = (text: string) => new TextEncoder().encode(text)

const split = (chunks: ReadonlyArray<string>, crTerminates?: boolean, maxLineBytes = 64) =>
  Effect.runPromise(
    Stream.runCollect(
      Transport.lines(
        "lines",
        maxLineBytes,
        Stream.fromIterable(chunks.map(bytes)),
        crTerminates === undefined ? {} : { crTerminates }
      )
    )
  )

describe("Transport.lines", () => {
  it("ends lines at LF only by default, dropping the CR of a CRLF and keeping blank lines", async () => {
    expect(await split(["a\rb\n", "x\r\n", "\n", "tail"])).toEqual(["a\rb", "x", "", "tail"])
  })

  it("ends lines at CR, LF, and CRLF when CR terminates, including a CRLF split across chunks", async () => {
    expect(await split(["a\rb\r", "\nc\r\n\r", "d", "\n"], true)).toEqual(["a", "b", "c", "", "d"])
  })

  it("keeps a pending CR across an empty chunk, so a split CRLF still ends one line", async () => {
    expect(await split(["data: a\r", "", "\ndata: b\r\n\r\n"], true)).toEqual(["data: a", "data: b", ""])
  })

  it.each([false, true])("keeps a split CRLF across multiple empty chunks in CR mode %s", async (crTerminates) => {
    expect(await split(["", "a\r", "", "", "\nb\n", ""], crTerminates)).toEqual(["a", "b"])
  })

  it("fails a line longer than the bound in either mode", async () => {
    for (const crTerminates of [false, true]) {
      await expect(split(["12345", "6\r"], crTerminates, 5)).rejects.toMatchObject({
        code: "protocol_error",
        message: "MCP frame exceeded 5 bytes"
      })
      await expect(split(["123456\n"], crTerminates, 5)).rejects.toMatchObject({
        message: "MCP frame exceeded 5 bytes"
      })
    }
  })
})

describe("Streamable HTTP event grouping", () => {
  it.each([1, 2])("joins data lines across a split CRLF with %s empty chunks", async (emptyChunks) => {
    const chunks = [
      "data: {\"jsonrpc\":\"2.0\",\r",
      ...Array.from({ length: emptyChunks }, () => ""),
      "\ndata: \"id\":1,\"result\":\"joined\"}\r\n\r\n"
    ]
    // The host service supplies a real response stream with explicit chunk
    // boundaries; a network socket may coalesce or drop empty writes.
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(
        request,
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(bytes(chunk))
              controller.close()
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
      ))
    )
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const transport = yield* HttpTransport.connect({ server: "events", url: "https://mcp.example.test/mcp" })
        return yield* transport.request("ping")
      })).pipe(Effect.provideService(HttpClient.HttpClient, http))
    )
    expect(result).toBe("joined")
  })
})
