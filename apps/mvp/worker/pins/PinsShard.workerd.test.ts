// Runs `PinsShard.vibe` inside a real Cloudflare workerd Durable Object (Miniflare) with SQLite storage
// to prove prototype-backed `DurableObjectStorage` (`sql`, `transactionSync`), compaction, and cold reload.
import { findPin, type Pins } from "@smthrs/app-state"
import { ShardProtocol } from "@smthrs/sync"
import { build } from "esbuild"
import { Schema } from "effect"
import type { Miniflare as MiniflareInstance } from "miniflare"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import { COMPATIBILITY } from "../test/workerd/bundle.ts"
import { options } from "../test/workerd/executionBundle.ts"

const SHARD = Schema.decodeUnknownSync(ShardProtocol.ShardId)("person:workerd-user-1")
const STREAM = Schema.decodeUnknownSync(ShardProtocol.StreamId)("person:workerd-user-1")
const C1 = "11111111-1111-4111-8111-111111111111"
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

let worker: MiniflareInstance | undefined

beforeAll(async () => {
  const bundled = await build({
    ...options,
    entryPoints: [fileURLToPath(new URL("../test/workerd/pins.ts", import.meta.url))],
  })
  worker = new Miniflare({
    workers: [{
      config: {
        name: "pins",
        compatibilityDate: COMPATIBILITY.date,
        compatibilityFlags: ["nodejs_compat"],
        manifest: { mainModule: "worker.js", modules: { "worker.js": { type: "esm", contents: bundled.outputFiles[0]!.text } } },
        env: { PINS: { type: "durable-object", worker: "pins", exportName: "PinsObject" } },
        exports: { PinsObject: { type: "durable-object", storage: "sqlite" } },
      },
    }],
  })
}, 120_000)

afterAll(async () => {
  await worker?.dispose()
})

test("PinsShard runs inside real Cloudflare workerd SQLite Durable Object across submit, compaction, and reload", async () => {
  const mf = worker!
  const headers = { "x-pins-shard": SHARD, "content-type": "application/json" }
  const initial = await (await mf.dispatchFetch("https://pins.local/state", { headers })).json() as {
    head: { epoch: number; seq: number }
    pins: Pins
    hash: string
  }
  expect(initial.pins.entries).toEqual([])

  const now = Date.now()
  const submitRes = await mf.dispatchFetch("https://pins.local/submit", {
    method: "POST",
    headers,
    body: JSON.stringify({
      version: ShardProtocol.protocolVersion,
      shard: SHARD,
      epoch: initial.head.epoch,
      command: {
        key: ["person:workerd-user-1/browser-1", "w-pin-1"],
        stream: STREAM,
        payload: {
          _tag: "SetPin",
          conversationId: C1,
          personId: "workerd-user-1",
          messageId: M1,
          changedAt: new Date(now).toISOString(),
          atMs: now,
        },
      },
    }),
  })
  expect(submitRes.status).toBe(200)
  expect((await submitRes.json() as { _tag: string })._tag).toBe("Accepted")

  const beforeCompact = await (await mf.dispatchFetch("https://pins.local/state", { headers })).json() as {
    pins: Pins
    hash: string
  }
  expect(findPin(beforeCompact.pins, C1)).toMatchObject({ messageId: M1, atMs: now })

  // Compact and evict in-memory hub, then reload cold from real workerd SQLite.
  expect((await mf.dispatchFetch("https://pins.local/compact", { method: "POST", headers })).status).toBe(200)
  const afterReload = await (await mf.dispatchFetch("https://pins.local/state", { headers })).json() as {
    pins: Pins
    hash: string
  }
  expect(afterReload.hash).toBe(beforeCompact.hash)
  expect(findPin(afterReload.pins, C1)).toMatchObject({ messageId: M1, atMs: now })
}, 60_000)
