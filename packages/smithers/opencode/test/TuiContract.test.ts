/**
 * The contract the real OpenCode TUI asks for.
 *
 * The hosted app was the only client this server had been driven by. On
 * 2026-09-18 the shipped TUI (`opencode attach http://127.0.0.1:4500 --dir
 * <repo>`, OpenCode 1.18.31) was attached to it through a pseudo-terminal
 * and every request it made was logged. It asks for six routes the app
 * never did, all six declared by the 1.18.31 OpenAPI document, and three of
 * them are what a client cannot work without:
 *
 * - `GET /config/providers` (`config.providers`). A 404 here ends the TUI
 *   at boot with `Error: Route not found` before it paints a frame.
 * - `POST /session/:id/message` (`session.prompt`). The TUI prompts through
 *   the synchronous route, not `prompt_async`, and a 404 paints
 *   `Failed to send prompt / Route not found`.
 * - `POST /permission/:permissionID/reply` (`permission.reply`). The TUI
 *   answers a permission card here, not at the session-scoped route, so a
 *   404 leaves the turn parked with nothing the person can press.
 *
 * The other three, `GET /project/:projectID/directories`,
 * `GET /experimental/capabilities` and `GET /experimental/console`, are
 * asked for on every boot and their 404s were tolerated. They answer too,
 * because a tolerated 404 is a route the next release may stop tolerating.
 *
 * Where a shape is one the 1.18.31 OpenAPI declares, the assertion is
 * against the declaration (`test/OpenApi.ts`), not a literal.
 */
import type { Message, Part } from "@opencode-ai/sdk"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Driver from "../src/Driver.ts"
import * as Protocol from "../src/Protocol.ts"
import * as Routes from "../src/Routes.ts"
import * as Serve from "../src/Serve.ts"
import * as Store from "../src/Store.ts"
import { scratchDirectory, serve, type Served, until } from "./Harness.ts"
import * as OpenApi from "./OpenApi.ts"

let served: Served
beforeAll(() => {
  served = serve()
  mkdirSync(join(served.directory, ".git"), { recursive: true })
  writeFileSync(join(served.directory, ".git", "HEAD"), "ref: refs/heads/main\n")
})
afterAll(() => served.dispose())

const ask = (path: string, init?: RequestInit): Promise<Response> =>
  served.handler(new Request(`http://test${path}`, init))

const post = (path: string, payload: unknown): Promise<Response> =>
  ask(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })

const bodyOf = async (path: string): Promise<unknown> => {
  const response = await ask(path)
  expect(response.status, path).toBe(200)
  return response.json()
}

const conforms = (schema: string, value: unknown): void => expect(OpenApi.violations(schema, value)).toEqual([])

const newSession = async (): Promise<string> => ((await (await post("/session", {})).json()) as { id: string }).id

/** Tails `/global/event` into a list, from `server.connected` on. */
const watch = async (): Promise<Array<{ type: string; properties: Record<string, unknown> }>> => {
  const stream = await ask("/global/event")
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  const seen: Array<{ type: string; properties: Record<string, unknown> }> = []
  let buffered = ""
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffered += decoder.decode(value)
      const frames = buffered.split("\n\n")
      buffered = frames.pop() ?? ""
      for (const frame of frames) {
        if (frame.startsWith("data: ")) seen.push(JSON.parse(frame.slice(6)).payload)
      }
    }
  })()
  await until(async () => seen.some((event) => event.type === "server.connected"))
  return seen
}

describe("the TUI's routes", () => {
  it("answers config.providers, which the TUI cannot boot without", async () => {
    const answer = await bodyOf("/config/providers") as {
      providers: Array<{ id: string; models: Record<string, unknown> }>
      default: Record<string, string>
    }
    expect(answer.providers).toHaveLength(1)
    expect(answer.providers[0]!.id).toBe("scripted")
    expect(answer.providers[0]!.models["demo"]).toMatchObject({ id: "demo", providerID: "scripted" })
    expect(answer.default).toEqual({ scripted: "demo" })
  })

  it("answers the project's directories with the one directory it serves", async () => {
    expect(await bodyOf(`/project/${Routes.projectID(served.directory)}/directories`))
      .toEqual([{ directory: served.directory }])
    const other = await ask("/project/not-this-one/directories")
    expect(other.status).toBe(404)
  })

  it("answers the two experimental routes the TUI reads on every boot", async () => {
    expect(await bodyOf("/experimental/capabilities")).toEqual({ backgroundSubagents: false })
    expect(await bodyOf("/experimental/console")).toEqual({ consoleManagedProviders: [], switchableOrgCount: 0 })
  })

  it("runs the turn behind session.prompt and answers the finished message", async () => {
    const seen = await watch()
    const session = await newSession()
    const prompted = post(`/session/${session}/message`, { parts: [{ type: "text", text: "fix the bug" }] })
    // The scripted turn parks on a permission, which is where the TUI's own
    // reply route comes in: the prompt route is still waiting for the answer.
    await until(async () =>
      seen.some((event) => event.type === "permission.asked" && event.properties["sessionID"] === session)
    )
    const asked = seen.find((event) => event.type === "permission.asked")!
      .properties as unknown as Protocol.PermissionRequest
    const unknown = await post(`/permission/per_nope/reply`, { reply: "once" })
    expect(unknown.status).toBe(404)
    const bad = await post(`/permission/${asked.id}/reply`, { reply: "maybe" })
    expect(bad.status).toBe(400)
    const replied = await post(`/permission/${asked.id}/reply`, { reply: "once" })
    expect(replied.status).toBe(200)
    expect(await replied.json()).toBe(true)

    const response = await prompted
    expect(response.status).toBe(200)
    const answer = await response.json() as { info: Message; parts: Array<Part> }
    // The route answers when the turn is over, not when it is accepted: the
    // TUI reads the finish of the message it gets back.
    expect(answer.info.role).toBe("assistant")
    expect((answer.info as Extract<Message, { role: "assistant" }>).finish).toBeDefined()
    conforms("AssistantMessage", answer.info)
    for (const part of answer.parts) conforms("Part", part)
    expect(answer.parts.some((part) => part.type === "text")).toBe(true)
    // The route answers as the projection closes, so the idle event is on its
    // way out rather than already out.
    await until(async () =>
      seen.some((event) => event.type === "session.idle" && event.properties["sessionID"] === session)
    )
  })

  // The prompt route reads the answer back out of the store, so a store that
  // lists no messages is the one way the read comes up empty. It is a defect
  // of the store, not of the request, and it answers as one instead of
  // leaving the TUI on a broken pipe.
  it("answers a typed 500 when the finished turn left no message to read", async () => {
    const scratch = scratchDirectory()
    const instant = Layer.succeed(Driver.Driver, {
      start: (_input, sink) => sink.closed({ _tag: "completed" }),
      interrupt: () => Effect.succeed(false),
      permission: () => Effect.void,
      steer: () => Effect.succeed(false),
      resumeOnBoot: () => Effect.void
    })
    const blind = Layer.effect(
      Store.Store,
      Effect.map(Store.Store, (real): Store.Service => ({ ...real, listMessages: () => Effect.succeed([]) }))
    ).pipe(Layer.provide(Store.layerSqlite(Serve.databasePath(scratch.directory))))
    const { dispose, handler } = HttpRouter.toWebHandler(
      Serve.app({
        directory: scratch.directory,
        bind: Serve.defaultBind,
        version: "test",
        seat: "scripted:demo",
        evaluator: Evaluator.layerUnavailable()
      }).pipe(Layer.provide(Layer.mergeAll(instant, blind))),
      { disableLogger: true }
    )
    try {
      const created = await handler(
        new Request("http://test/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        })
      )
      const session = (await created.json() as { id: string }).id
      const response = await handler(
        new Request(`http://test/session/${session}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] })
        })
      )
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        name: "UnknownError",
        data: { message: `Session ${session} has no answer` }
      })
    } finally {
      await dispose()
      scratch.remove()
    }
  })

  it("refuses an unknown session and an empty prompt the way prompt_async does", async () => {
    const missing = await post("/session/ses_missing/message", { parts: [{ type: "text", text: "x" }] })
    expect(missing.status).toBe(404)
    const empty = await post(`/session/${await newSession()}/message`, { parts: [] })
    expect(empty.status).toBe(400)
  })
})
