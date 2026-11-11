/** The root and timed routes run without ambient platform filesystem access. */
import { build } from "esbuild"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { createContext, runInContext } from "node:vm"
import vibelang from "vibelang-unplugin/esbuild"
import { expect, it } from "vitest"

it.each([
  { name: "browser", conditions: [] },
  { name: "Worker", conditions: ["workerd", "worker", "browser"] }
])(
  "runs the root's timed route with web globals ($name)",
  async ({ conditions }) => {
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the request */ }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as { port: number }
    try {
      const result = await build({
        plugins: [vibelang({ root: fileURLToPath(new URL("..", import.meta.url)) })],
        stdin: {
          contents: `
          import { Route, RequestExecutor, ModelRequest } from "./src/index.ts"
          import { Effect, Redacted, Result, Stream } from "effect"
          import { FetchHttpClient } from "effect/http"
          export * from "./src/index.ts"
          export const run = (url) => Effect.runPromise(Effect.gen(function*() {
            const route = Result.getOrThrow(Route.openaiChatCompatible({ id: "web", providerName: "web", baseUrl: url, apiKey: Redacted.make("test-key") }))
            const model = yield* Route.toModel(route)
            return yield* Stream.runCollect(model.stream(ModelRequest.ModelRequest.make({
              modelId: "test", system: [], messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
              tools: [], params: ModelRequest.GenerationParams.make()
            })))
          }).pipe(Effect.provide(RequestExecutor.layer), Effect.provide(FetchHttpClient.layer)))
        `,
          resolveDir: fileURLToPath(new URL("..", import.meta.url)),
          loader: "ts"
        },
        bundle: true,
        platform: "browser",
        conditions,
        format: "iife",
        globalName: "realm",
        write: false,
        logLevel: "silent"
      })
      for (const hasProcess of [false, true]) {
        const context = createContext({
          AbortController,
          AbortSignal,
          DOMException,
          Headers,
          ReadableStream,
          Request,
          Response,
          TextDecoder,
          TextEncoder,
          URL,
          URLSearchParams,
          atob,
          btoa,
          clearInterval,
          clearTimeout,
          console,
          crypto,
          fetch,
          performance,
          queueMicrotask,
          setInterval,
          setTimeout,
          structuredClone,
          ...(hasProcess
            ? {
              process: {
                get env() {
                  throw new Error("No ambient host access")
                }
              }
            }
            : {})
        })
        runInContext(result.outputFiles[0]!.text, context)
        const events = await runInContext(`realm.run("http://127.0.0.1:${address.port}")`, context) as Array<
          Record<string, any>
        >
        expect(events.find((event) => event["type"] === "text-delta")?.["text"]).toBe("hello")
        expect(events.find((event) => event["type"] === "settle")?.["timing"]).toMatchObject({
          attempts: 1,
          preparedMs: expect.any(Number)
        })
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }
)
