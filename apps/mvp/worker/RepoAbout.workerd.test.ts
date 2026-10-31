// Real RepoApi + AboutStore under workerd's request-owned I/O rules, reading GitHub over the network: the scripted
// GitHub (worker/test/githubRest.ts) served by a real HTTP server in this process, as `GITHUB_API_URL`. GitHub isn't
// what this tests, so the test needs no internet. Node's concurrent test cannot detect cross-request Effect
// Cache/Deferred sharing.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { Miniflare } from "miniflare"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { GITHUB_API, scriptedGitHub } from "./test/githubRest.ts"
import { testFile } from "./test/harness.ts"
import { answer, assertBodiesConsumed, bundle, COMPATIBILITY } from "./test/workerd/bundle.ts"

/** How long the scripted GitHub takes to answer each call, as the network would: every first reader arrives meanwhile. */
const LATENCY_MS = 100

const runtime = testFile("about_workerd")
const github = scriptedGitHub()
github.publish("octocat", "Spoon-Knife")
// GitHub's API on a local port: each request as the scripted GitHub's `Request`, its answer written back after LATENCY_MS.
const server: Server = createServer(async (incoming, outgoing) => {
  const chunks: Array<Buffer> = []
  for await (const chunk of incoming) chunks.push(chunk as Buffer)
  const headers = new Headers()
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!)
  const request = new Request(new URL(incoming.url!, GITHUB_API), {
    method: incoming.method!,
    headers,
    ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
  })
  await sleep(LATENCY_MS)
  const response = await github.fetch(request)
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  outgoing.end(Buffer.from(await response.arrayBuffer()))
})
let worker: Miniflare
let restore: (() => void) | undefined
beforeAll(async () => {
  restore = assertBodiesConsumed()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
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
      GITHUB_API_URL: { type: "text", value: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
    },
  } }] })
  expect((await answer(worker, "http://about/initialize")).status).toBe(200)
}, 120_000)
afterAll(async () => {
  await worker?.dispose()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
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
  // Every answer is the scripted GitHub's, from one read of it.
  expect(github.calls.filter((call) => call === "")).toEqual([""])
}, 60_000)
