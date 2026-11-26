// `ViewsClient` (src/features/views/api.ts) over transports that fail as networks and servers do: injected `fetch`
// implementations, never a fake ChatApi. Its real exchanges with ChatApi are steps.test.ts and agentViews.test.ts.
import { Effect, Exit, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { ViewsClient } from "./api.vibe"

const clientOver = (fetch: typeof globalThis.fetch) =>
  ViewsClient.layer({ origin: "http://chat.test", within: "5 seconds" }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )

const run = <A, E>(fetch: typeof globalThis.fetch, use: (client: ViewsClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.exit(Effect.flatMap(Effect.service(ViewsClient), use).pipe(Effect.provide(clientOver(fetch)))))

const answering = (status: number, body: string): typeof globalThis.fetch => () =>
  Promise.resolve(new Response(body, { status }))

const move = { moveId: "m", revision: 0, event: { name: "cell", arg: "1" } }
const form = {
  id: crypto.randomUUID(),
  template: "form" as const,
  props: { title: "T", schema: { type: "object" }, submitLabel: "Send" },
}

describe("ViewsClient", () => {
  test("no network is a refusal with no status, for adding and moving", async () => {
    const offline: typeof globalThis.fetch = () => Promise.reject(new TypeError("offline"))
    expect(Exit.isFailure(await run(offline, (client) => client.add(form)))).toBe(true)
    expect(Exit.isFailure(await run(offline, (client) => client.setState("v", move)))).toBe(true)
  })

  test("an answer it can't read is a refusal with its status", async () => {
    const added = await run(answering(202, "not json"), (client) => client.add(form))
    expect(JSON.stringify(added)).toContain('"status":202')
    const moved = await run(answering(200, '{"txid":"x"}'), (client) => client.setState("v", move))
    expect(JSON.stringify(moved)).toContain('"status":200')
  })

  test("a refusal carries ChatApi's code, a module's detail, or the revision a stale move found", async () => {
    expect(JSON.stringify(await run(answering(403, '{"code":"forbidden"}'), (client) => client.add(form)))).toContain(
      '"code":"forbidden"',
    )
    expect(JSON.stringify(await run(answering(422, '{"code":"not_rendered","detail":"1:1: x"}'), (client) => client.add(form))))
      .toContain('"detail":"1:1: x"')
    expect(JSON.stringify(await run(answering(409, '{"code":"stale","revision":3}'), (client) => client.setState("v", move))))
      .toContain('"revision":3')
    expect(JSON.stringify(await run(answering(500, ""), (client) => client.setState("v", move)))).toContain('"status":500')
  })

  test("a refusal whose body can't be read is a refusal with its status alone", async () => {
    const unreadable: typeof globalThis.fetch = () =>
      Promise.resolve(new Response(new ReadableStream({ start: (controller) => controller.error(new Error("cut")) }), { status: 500 }))
    expect(JSON.stringify(await run(unreadable, (client) => client.add(form)))).toContain('"status":500')
    expect(JSON.stringify(await run(unreadable, (client) => client.setState("v", move)))).toContain('"status":500')
  })

  test("a move ChatApi made answers its revision", async () => {
    expect(await run(answering(200, '{"txid":null,"revision":4}'), (client) => client.setState("v", move))).toEqual(
      Exit.succeed(4),
    )
  })

  test("no whole answer within the deadline is a refusal", async () => {
    const stalled: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
    const layer = ViewsClient.layer({ origin: "http://chat.test", within: "50 millis" }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stalled)),
    )
    const uses: ReadonlyArray<(client: ViewsClient["Service"]) => Effect.Effect<unknown, unknown>> = [
      (client) => client.setState("v", move),
      (client) => client.add(form),
    ]
    for (const use of uses) {
      const exit = await Effect.runPromise(Effect.exit(Effect.flatMap(Effect.service(ViewsClient), use).pipe(Effect.provide(layer))))
      expect(Exit.isFailure(exit)).toBe(true)
    }
  })
})
