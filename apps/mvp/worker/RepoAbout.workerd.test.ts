// Real RepoApi + AboutStore + GitHub, under workerd's request-owned I/O rules.
// Node's concurrent test cannot detect cross-request Effect Cache/Deferred sharing.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { testFile } from "./test/harness.ts"
import { answer, assertBodiesConsumed, bundle, COMPATIBILITY } from "./test/workerd/bundle.ts"

const runtime = testFile("about_workerd")
let worker: Miniflare
let restore: (() => void) | undefined
beforeAll(async () => {
  restore = assertBodiesConsumed()
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const url = await runtime.runPromise(TestDatabase.serverUrl)
  const output = await bundle(fileURLToPath(new URL("./test/workerd/about.ts", import.meta.url)))
  const modules = Object.fromEntries(output.map((file) => file.type === "chunk"
    ? [file.fileName, { type: "esm" as const, contents: file.code }]
    : [file.fileName, { type: "wasm" as const, contents: Buffer.from(file.source) }]))
  worker = new Miniflare({ workers: [{ config: {
    name: "about",
    compatibilityDate: COMPATIBILITY.date,
    compatibilityFlags: COMPATIBILITY.flags,
    manifest: { mainModule: "worker.js", modules },
    env: {
      HYPERDRIVE: { type: "hyperdrive", id: "about", dev: { connectionString: url.toString() } },
      SCHEMA: { type: "text", value: scratch.name },
    },
  } }] })
  expect((await answer(worker, "http://about/initialize")).status).toBe(200)
}, 120_000)
afterAll(async () => {
  await worker?.dispose()
  restore?.()
})

test("30 concurrent first About reads all return 200 in workerd", async () => {
  expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT repo_id FROM repo_about`))).toEqual([])
  // The schema has no repo_about rows. All requests enter one isolate before its first GitHub read settles.
  // Each body is read as its response arrives (bundle.ts `answer`).
  const responses = await Promise.all(Array.from({ length: 30 }, () =>
    answer(worker, "http://about/api/repos/octocat/Spoon-Knife/about")))
  expect(responses.map((response) => response.status)).toEqual(Array(30).fill(200))
  for (const response of responses) {
    expect(JSON.parse(response.body)).toMatchObject({ name: "octocat/Spoon-Knife" })
  }
}, 60_000)
