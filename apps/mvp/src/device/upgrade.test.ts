import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { Chat } from "../features/chat/chat"
import { ChatStore } from "../features/chat/store"
import { IssueWrites } from "../features/issues/writes"
import { StackWrites } from "../features/todos/writes"
import { SqlClient } from "effect/sql"
import { member, nodeDevice, openTab, TestChatApi } from "../test/chatApi"
import { deviceFrom, type Fixture, prepare } from "../test/deviceFixture"
import deployed from "./fixtures/7b96f878.json" with { type: "json" }
import currentDeployed from "./fixtures/c6940ac53e5a.json" with { type: "json" }
import todoDeployed from "./fixtures/7df7c2ecb983.json" with { type: "json" }
import { deviceRegistry } from "./registry"

// The deployed build's device, opened by this build's app over the real ChatApi (decision 0021): the leader's
// `device/prepare` brings the store forward first (here, `prepare` on the device's file), then the app finds every
// local row, keeps the stored draft as the composer's, sends the question the old build queued, and
// shows the write it can't send as Not sent.

const runtimes: Array<{ readonly dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>) => vi.waitFor(assertion, { timeout: 20_000, interval: 25 })

const QUESTION = "6f1c2a3e-0000-4000-8000-000000000001"
const AGENT_WRITE = "c0ffee00-0000-4000-8000-000000000004"

test.each([deployed, currentDeployed])(
  "build $build opens with its draft, its queued question sent, and its writes accounted for",
  async (deployed) => {
    const fixture = deployed as Fixture
    // The person the old build confirmed comes back: ChatApi says they are signed in, under the login the device kept.
    const person = { ...member, login: "codeplanesmithers" }
    const server = ManagedRuntime.make(
      TestChatApi.layerWith({ actor: person }).pipe(Layer.provideMerge(TestDatabase.layer("test_device"))),
    )
    runtimes.push(server)
    const api = await server.runPromise(Effect.service(TestChatApi))
    const { outbox, path } = await deviceFrom(fixture)
    await prepare(path, deviceRegistry)
    const host = nodeDevice({ agent: api, file: path, outboxEntries: outbox })
    const runtime = openTab(api, { host })
    runtimes.push(runtime)
    const [chat, store, issues] = await runtime.runPromise(
      Effect.all([Effect.service(Chat), Effect.service(ChatStore), Effect.service(IssueWrites)])
    )
    store.composerState.tanstack.startSyncImmediate()

    // The draft the old build kept for the home conversation is the composer's draft again.
    await until(() => expect(chat.queries.composer.toArray[0]?.draft).toBe("Half a thought about the release"))

    // The question the old build queued offline reached ChatApi once, under its own id.
    await until(async () =>
      expect((await server.runPromise(api.rows)).filter(({ id }) => id === QUESTION).map(({ text }) => text)).toEqual([
        "What changed in the last deploy?"
      ])
    )

    // The question the server refused before the deploy is still Not sent.
    expect(Option.getOrUndefined(await runtime.runPromise(store.unsent.get("0a1b2c3d-0000-4000-8000-0000000000aa"))))
      .toMatchObject({ text: "A question the server refused", reason: "refused" })

    // The unstamped agent write cannot migrate; the newer opaque credential
    // cannot renew. Both stay Not sent with the route's precise refusal.
    await until(async () =>
      expect(Option.getOrUndefined(await runtime.runPromise(issues.requested.get(AGENT_WRITE)))).toMatchObject({
        body: "Triaged by the agent.",
        status: "not_sent",
        reason: fixture.build === "7b96f878" ? "not_allowed" : "forbidden"
      })
    )
    expect([...outbox.keys()].filter((key) => key.startsWith("parked:"))).toEqual([])

    // The theme the old build stored still paints.
    await until(() => expect(host.painted.at(-1)).toBe("dark"))
  },
  60_000
)

test("a follower restores a newer payload as Not sent while another tab holds the outbox", async () => {
  const server = ManagedRuntime.make(TestChatApi.layer.pipe(Layer.provideMerge(TestDatabase.layer("test_device_future"))))
  runtimes.push(server)
  const api = await server.runPromise(Effect.service(TestChatApi))
  const future = structuredClone(currentDeployed as Fixture)
  const [key, encoded] = Object.entries(future.outbox).find(([, raw]) => JSON.parse(raw).mutationFnName === "ask")!
  const transaction = JSON.parse(encoded)
  transaction.metadata = { ...transaction.metadata, versions: { asking: 99 } }
  const { outbox, path } = await deviceFrom({ ...future, outbox: { [key]: JSON.stringify(transaction) } })
  await prepare(path, deviceRegistry)
  const host = nodeDevice({ agent: api, file: path, outboxEntries: outbox, lock: { hold: () => Effect.never, tryHold: () => Effect.succeed(Option.none()) } })
  const runtime = openTab(api, { host })
  runtimes.push(runtime)
  const store = await runtime.runPromise(Effect.service(ChatStore))
  await until(async () => expect(Option.getOrUndefined(await runtime.runPromise(store.unsent.get(QUESTION)))).toMatchObject({
    text: "What changed in the last deploy?", reason: "not_admitted",
  }))
  expect((await server.runPromise(api.rows)).filter(({ id }) => id === QUESTION)).toEqual([])
  expect([...outbox.keys()].filter((name) => name.startsWith("parked:"))).toEqual([])
}, 60_000)

test("build 7df7c2ecb983's stack changes open in this build: its queued commit is sent once, its Requested and Not sent rows stay", async () => {
  const fixture = todoDeployed as Fixture
  const server = ManagedRuntime.make(TestChatApi.layerWith({ actor: member }).pipe(Layer.provideMerge(TestDatabase.layer("test_device_todos"))))
  runtimes.push(server)
  const api = await server.runPromise(Effect.service(TestChatApi))
  const { outbox, path } = await deviceFrom(fixture)
  await prepare(path, deviceRegistry)
  const host = nodeDevice({ agent: api, file: path, outboxEntries: outbox })
  const runtime = openTab(api, { host })
  runtimes.push(runtime)
  const writes = await runtime.runPromise(Effect.service(StackWrites))
  const QUEUED = "7df7c2ec-0000-4000-8000-0000000000a4"
  const committed = () => server.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly title: string }>`SELECT id::text, title FROM todos WHERE id = ${QUEUED}::uuid`))
  // The commit the old build queued offline reaches the stack once, under its own op id, and is Requested here.
  await until(async () => expect(await committed()).toEqual([{ id: QUEUED, title: "Queued offline before the deploy" }]))
  await until(async () => expect(Option.getOrUndefined(await runtime.runPromise(writes.requested.get(QUEUED)))).toMatchObject({ status: "requested" }))
  // The rows the old build kept are as it kept them.
  for (const row of fixture.collections["todo-requested"]!.rows) {
    expect(Option.getOrUndefined(await runtime.runPromise(writes.requested.get(String(row.id))))).toMatchObject(row)
  }
  expect([...outbox.keys()].filter((key) => key.startsWith("parked:"))).toEqual([])
  expect(await committed()).toHaveLength(1)
}, 60_000)
