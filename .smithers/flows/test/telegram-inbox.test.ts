import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Interpreter } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import * as MemoryStore from "../../../packages/smithers/agent/memory/src/MemoryStore.ts"
import * as TestMemory from "../../../packages/smithers/agent/memory/src/test/TestMemory.ts"
import Inbox, { entry, layer, Request } from "../telegram-inbox/flow.ts"

const TOKEN = "123456:inbox-fixture"
const WILL = 1001

const message = (id: number, chat: number, text: string) => ({
  message_id: id,
  date: 1_700_000_000 + id,
  chat: { id: chat, type: "private" },
  from: { id: chat, is_bot: false },
  text
})

/** A Bot API that answers getUpdates from a fixed backlog, honoring the offset unless told to ignore it. */
const botApi = async (options: { readonly ignoreOffset?: boolean } = {}) => {
  const backlog = [
    { update_id: 10, message: message(1, WILL, "first") },
    { update_id: 11, message: message(2, 999, "from a stranger") },
    { update_id: 12, edited_message: message(1, WILL, "first, edited") }
  ]
  const offsets: Array<number | undefined> = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      assert.equal(request.url, `/bot${TOKEN}/getUpdates`)
      const offset = (JSON.parse(body) as { offset?: number }).offset
      offsets.push(offset)
      const result = backlog.filter((update) => options.ignoreOffset === true || update.update_id >= (offset ?? 0))
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: true, result }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, offsets, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** Runs the inbox flow twice on one engine, database and memory store, and reads the thread. */
const twoRuns = (apiBaseUrl: string) => {
  const live = Interpreter.layerWithImplementations(Inbox, layer).pipe(
    Layer.provideMerge(
      // NodeCrypto last: TestMemory's deterministic digest must not reach the engine.
      Layer.mergeAll(FlowEngine.layerMemory, TestMemory.layerWithDatabase, NodeCrypto.layer, FetchHttpClient.layer)
    )
  )
  const data: typeof Request.Type = {
    allowedChatIds: [String(WILL)],
    thread: "telegram/inbox",
    maxTurns: 1,
    pollTimeoutSeconds: 0,
    apiBaseUrl
  }
  return Effect.runPromise(
    Effect.gen(function*() {
      yield* Inbox.execute(data, { executionId: "inbox-run-1" })
      yield* Inbox.execute(data, { executionId: "inbox-run-2" })
      const store = yield* MemoryStore.MemoryStore
      return yield* store.listMessages({ threadId: "telegram/inbox" })
    }).pipe(Effect.provide(live), Effect.scoped)
  )
}

test("records each allowed message once and the next run polls past the committed offset", async () => {
  process.env["SMITHERS_TELEGRAM_BOT_TOKEN"] = TOKEN
  const api = await botApi()
  try {
    const messages = await twoRuns(api.origin)
    assert.deepEqual(api.offsets, [undefined, 13])
    assert.deepEqual(messages.map((row) => [row.id, row.role, JSON.parse(row.text)]), [
      [
        "update:8:telegram:10",
        "user",
        {
          event: "integration:telegram:message",
          chatId: WILL,
          fromId: WILL,
          messageId: 1,
          date: 1_700_000_001,
          text: "first"
        }
      ],
      [
        "update:8:telegram:12",
        "user",
        {
          event: "integration:telegram:edited_message",
          chatId: WILL,
          fromId: WILL,
          messageId: 1,
          date: 1_700_000_001,
          text: "first, edited"
        }
      ]
    ])
  } finally {
    await api.close()
  }
})

test("a batch delivered again records nothing twice", async () => {
  process.env["SMITHERS_TELEGRAM_BOT_TOKEN"] = TOKEN
  const api = await botApi({ ignoreOffset: true })
  try {
    const messages = await twoRuns(api.origin)
    assert.deepEqual(api.offsets, [undefined, 13])
    assert.deepEqual(messages.map((row) => row.id), ["update:8:telegram:10", "update:8:telegram:12"])
  } finally {
    await api.close()
  }
})

test("an entry keeps the caption of a media message and nulls what the message lacks", () => {
  const row = JSON.parse(entry({
    eventName: "integration:telegram:message",
    payload: { caption: "a photo" }
  }))
  assert.deepEqual(row, {
    event: "integration:telegram:message",
    chatId: null,
    fromId: null,
    messageId: null,
    date: null,
    text: "a photo"
  })
})
