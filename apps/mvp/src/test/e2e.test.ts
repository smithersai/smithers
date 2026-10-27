import { Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import type { ChatView } from "../features/chat/chat"
import { nodeDevice, TestChatApi } from "./chatApi"
import { AuthClient, AuthUnreachable } from "../features/auth/api"
import { AuthFaults, faultyAuth, faultySession } from "./authFaults"
import { opening, sessionDown, startWithFaults, type Switches } from "./e2e"

// The end-to-end entry's composition: the app on faulty services, with their switches on the window.

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 10_000, interval: 20 })

test("?faults names the switch the shape source opens with, and nothing else opens it faulty", () => {
  for (const search of ["?faults", "?faults=", "?faults=unknown", ""]) expect(opening(search)).toBeUndefined()
  for (const search of ["?faults=down", "?faults=refuse", "?faults=refuse-502", "?faults=stall", "?faults=corrupt"]) {
    expect(opening(search)).toBeInstanceOf(Function)
  }
})

test("?faults=session-503 refuses every session read, the engine worker's too, until the page heals it", async () => {
  expect([sessionDown("?faults=session-503"), sessionDown("?faults"), sessionDown("?faults=down")]).toEqual([true, false, false])
  const answer = { signedIn: false as const, available: true }
  const page = ManagedRuntime.make(
    faultyAuth(sessionDown("?faults=session-503")).pipe(
      Layer.provide(Layer.succeed(AuthClient, AuthClient.of({ session: Effect.succeed(answer), signOut: Effect.void }))),
    ),
  )
  runtimes.push(page)
  const worker = faultySession(Effect.succeed(answer), true)
  const read = () => page.runPromise(Effect.flatMap(Effect.service(AuthClient), (client) => Effect.result(client.session)))
  const refused = { _tag: "Failure", failure: new AuthUnreachable({ status: 503 }) }
  expect(await read()).toMatchObject(refused)
  expect(await Effect.runPromise(Effect.result(worker))).toMatchObject(refused)
  const faults = await page.runPromise(Effect.service(AuthFaults))
  await page.runPromise(faults.heal)
  expect(await read()).toMatchObject({ _tag: "Success", success: answer })
  await until(async () => expect(await Effect.runPromise(Effect.result(worker))).toMatchObject({ _tag: "Success", success: answer }))
  await page.runPromise(faults.down)
  await until(async () => expect(await Effect.runPromise(Effect.result(worker))).toMatchObject(refused))
})

// The faulty services' window switches, on the app as `?faults` opens it: healthy until a test throws one.
const openOnWindow = async (search: string, name: string) => {
  const host = ManagedRuntime.make(TestChatApi.layer.pipe(Layer.provideMerge(TestDatabase.layer(name))))
  runtimes.push(host)
  const api = await host.runPromise(Effect.service(TestChatApi))
  const rendered: Array<ChatView> = []
  const window: { faults?: Switches } = {}
  const { stop } = await startWithFaults(
    {
      origin: api.origin,
      fetch: api.fetch,
      reload: api.reload,
      host: nodeDevice(),
      unreachableAfter: "300 millis",
      target: new EventTarget(),
      startedAt: Date.now(),
      render: (chat) => rendered.push(chat),
    },
    search,
    window,
  )
  // The switches are on the window once the services are built; the program renders a moment later.
  await until(() => expect(rendered).toHaveLength(1))
  return { host, api, chat: rendered[0]!, faults: window.faults!, stop }
}

test("the window's questions switches: the next question fails, and asked lists every question", async () => {
  const { host, api, chat, faults, stop } = await openOnWindow("?faults", "test_e2e_questions")
  await chat.queries.connection.preload()
  expect(faults.questions.asked()).toEqual([])

  faults.questions.failNext("bad_request")
  const lost = (await chat.actions.ask("  lost  "))
  if (!lost.asked) throw new Error(`the question was refused: ${lost.reason}`)
  await chat.queries.conversation.preload()
  await until(() =>
    expect(chat.queries.conversation.toArray.find(({ id }) => id === lost.questionId)?.status).toBe("unsent"),
  )
  expect(faults.questions.asked()).toEqual([{ id: lost.questionId, answerId: lost.answerId, text: "lost" }])
  expect(await host.runPromise(api.rows)).toEqual([])

  // The fault was for one question: the next goes through to ChatApi, and asked lists both, in order.
  const kept = (await chat.actions.ask("kept"))
  if (!kept.asked) throw new Error(`the question was refused: ${kept.reason}`)
  await until(async () => expect((await host.runPromise(api.rows)).map(({ id }) => id)).toEqual([kept.questionId, kept.answerId]))
  expect(faults.questions.asked().map(({ text }) => text)).toEqual(["lost", "kept"])
  await stop()
})

test.each([
  ["?faults=refuse-502", { status: "offline", retry: true }],
  ["?faults=refuse", { status: "failed", retry: true }],
])("%s opens the app with its sync failing, and the window's switches heal it", async (search, failed) => {
  const host = ManagedRuntime.make(TestChatApi.layer.pipe(Layer.provideMerge(TestDatabase.layer("test_e2e"))))
  runtimes.push(host)
  const api = await host.runPromise(Effect.service(TestChatApi))
  const rendered: Array<ChatView> = []
  const window: { faults?: Switches } = {}
  const { stop } = await startWithFaults(
    {
      origin: api.origin,
      fetch: api.fetch,
      reload: api.reload,
      host: nodeDevice(),
      unreachableAfter: "300 millis",
      target: new EventTarget(),
      startedAt: Date.now(),
      render: (chat) => rendered.push(chat),
    },
    search,
    window,
  )
  await until(() => expect(rendered).toHaveLength(1))
  const connection = rendered[0]!.queries.connection
  await connection.preload()
  await until(() => expect(connection.toArray[0]).toMatchObject(failed))
  window.faults!.shapes.heal()
  rendered[0]!.actions.retry()
  await until(() => expect(connection.toArray[0]?.status).toBe("up"))
  window.faults!.shapes.refuse(503)
  window.faults!.shapes.down("live")
  window.faults!.shapes.stall("live")
  window.faults!.shapes.corrupt("live")
  window.faults!.questions.failNext("refused")
  window.faults!.engine.refuseResults("chat/Answer", "payload_changed")
  window.faults!.shapes.heal()
  await stop()
})


test("a closed ChatApi refuses new requests before its database is dropped", async () => {
  const host = ManagedRuntime.make(TestChatApi.layer.pipe(
    Layer.provideMerge(TestDatabase.layer("test_closed_chat_api")),
  ))
  runtimes.push(host)
  const api = await host.runPromise(Effect.service(TestChatApi))
  const initial = await api.fetch(`${api.origin}/api/shapes/messages?offset=-1`)
  expect(initial.status).toBe(200)
  await initial.text()
  await host.dispose()
  const response = await api.fetch(`${api.origin}/api/auth/session`)
  expect(response.status).toBe(503)
  expect(await response.text()).toBe("")
})

test("closing ChatApi aborts an unread real Electric response before dropping its schema", async () => {
  const host = ManagedRuntime.make(TestChatApi.layer.pipe(
    Layer.provideMerge(TestDatabase.layer("test_streaming_chat_api_close")),
  ))
  runtimes.push(host)
  const api = await host.runPromise(Effect.service(TestChatApi))
  const response = await api.fetch(`${api.origin}/api/shapes/messages?offset=-1`)
  expect(response.status).toBe(200)
  expect(response.body).not.toBeNull()
  await host.dispose()
  expect(typeof await response.text()).toBe("string")
  expect((await api.fetch(`${api.origin}/api/auth/session`)).status).toBe(503)
})
