// A run's artifacts (worker/branch/Artifacts.ts, docs/features/ci.md#artifacts) in workerd, bundled as Alchemy bundles
// ChatApi, over a real R2 binding, through real HTTP requests: what a job box's PUT and GET do. Node can't show what
// only workerd decides: a streamed body R2 takes only at a known length (`FixedLengthStream`).
import { digestSync } from "@smthrs/crypto"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import { answer, bundle, COMPATIBILITY } from "../test/workerd/bundle.ts"

let worker: Miniflare
beforeAll(async () => {
  const output = await bundle(fileURLToPath(new URL("../test/workerd/artifacts.ts", import.meta.url)))
  const modules = Object.fromEntries(output.map((file) => file.type === "chunk"
    ? [file.fileName, { type: "esm" as const, contents: file.code }]
    : [file.fileName, { type: "wasm" as const, contents: Buffer.from(file.source) }]))
  worker = new Miniflare({ workers: [{ config: {
    name: "artifacts",
    compatibilityDate: COMPATIBILITY.date,
    compatibilityFlags: COMPATIBILITY.flags,
    manifest: { mainModule: "worker.js", modules },
    env: { ARTIFACTS: { type: "r2" } },
  } }] })
}, 120_000)
afterAll(() => worker?.dispose())

const urlOf = (name: string) => `http://artifacts.smithers.internal/${name}`
const RUN_A = "a".repeat(40)
const RUN_B = "b".repeat(40)

/** One request's status, its body read at once (worker/test/workerd/bundle.ts `answer`). */
const status = async (name: string, init: Parameters<Miniflare["dispatchFetch"]>[1]) => {
  const response = await worker.dispatchFetch(urlOf(name), init)
  await response.arrayBuffer()
  return response.status
}

test("a multi-megabyte artifact round-trips under its run's scope; another run's scope reads nothing", async () => {
  const body = new Uint8Array(16 * 1024 * 1024).map((_, index) => (index * 7) % 256)
  expect(await status("shard-3.blob", { method: "PUT", body, headers: { "x-scope": RUN_A } })).toBe(201)

  const got = await worker.dispatchFetch(urlOf("shard-3.blob"), { headers: { "x-scope": RUN_A } })
  expect(got.status).toBe(200)
  expect(got.headers.get("content-length")).toBe(String(body.length))
  // Compared as buffers: a 16 MiB element-wise diff would exhaust the test's heap.
  expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(body))).toBe(true)

  expect(await status("shard-3.blob", { headers: { "x-scope": RUN_B } })).toBe(404)
  expect(await status("never-written", { headers: { "x-scope": RUN_A } })).toBe(404)
}, 60_000)

test("refusals: 403 without a scope, 400 for a bad name, 405 for another method, 411 for a streamed body", async () => {
  expect(await status("a", { method: "PUT", body: "x" })).toBe(403)
  expect(await status("a/b", { headers: { "x-scope": RUN_A } })).toBe(400)
  expect(await status("a", { method: "DELETE", headers: { "x-scope": RUN_A } })).toBe(405)
  const stream = new ReadableStream({ start: (controller) => (controller.enqueue(new Uint8Array([1, 2])), controller.close()) })
  expect(await status("a", { method: "PUT", body: stream, duplex: "half", headers: { "x-scope": RUN_A } } as never)).toBe(411)
}, 60_000)

test("Smithers-Ops returns the same 404 for missing and hidden artifacts over Worker HTTP", async () => {
  const run = "ci:ops-fixture"
  const scope = digestSync(`run:${run}`).slice(0, 40)
  expect(await status("private.txt", { method: "PUT", body: "private bytes", headers: { "x-scope": scope } })).toBe(201)
  const url = (name: string) => `http://smithers.test/api/repos/smithersai/Smithers-Ops/artifacts/${run}/${name}`
  const owner = { headers: { "x-test-login": "roninjin10" } }
  expect(await answer(worker, url("private.txt"), owner)).toMatchObject({ status: 200, body: "private bytes" })
  const missing = await answer(worker, url("absent.txt"), owner)
  expect(missing).toMatchObject({ status: 404, body: '{"error":"not_found"}' })
  for (const init of [undefined, { headers: { "x-test-login": "someone-else" } }]) {
    const hidden = await answer(worker, url("private.txt"), init)
    expect(hidden.status).toBe(missing.status)
    expect(hidden.body).toBe(missing.body)
    expect([...hidden.headers].filter(([name]) => name !== "date"))
      .toEqual([...missing.headers].filter(([name]) => name !== "date"))
  }
})
