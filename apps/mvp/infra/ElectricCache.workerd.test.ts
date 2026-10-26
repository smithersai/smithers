// Real Electric -> workerd gateway -> service binding -> ShapeProxy -> browser. Workers Cache's edge collapse itself
// is deployed-only; this suite verifies the parts that workerd runs, without substituting an in-memory cache.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { testFile } from "../worker/test/harness.ts"
import { answer, bundle, COMPATIBILITY } from "../worker/test/workerd/bundle.ts"

const runtime = testFile("cache_workerd")
let worker: Miniflare
let table: string
beforeAll(async () => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  table = `${scratch.name}.cache_people`
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    CREATE TABLE cache_people (id text PRIMARY KEY, person text NOT NULL, value text NOT NULL)`))
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO cache_people VALUES ('a', 'alice', 'alice-only'), ('b', 'bob', 'bob-only')`))
  const electric = await runtime.runPromise(TestDatabase.electricUrl)
  const output = await bundle(fileURLToPath(new URL("./test/electric-cache-worker.ts", import.meta.url)))
  const modules = Object.fromEntries(output.map((file) => file.type === "chunk"
    ? [file.fileName, { type: "esm" as const, contents: file.code }]
    : [file.fileName, { type: "wasm" as const, contents: Buffer.from(file.source) }]))
  const config = { compatibilityDate: COMPATIBILITY.date, compatibilityFlags: COMPATIBILITY.flags,
    manifest: { mainModule: "worker.js", modules } }
  worker = new Miniflare({ workers: [
    { config: { ...config, name: "browser", env: {
      ROLE: { type: "text", value: "browser" }, TABLE: { type: "text", value: table },
      ELECTRIC_GATEWAY: { type: "worker", worker: "gateway" },
    } } },
    { config: { ...config, name: "gateway", cache: { enabled: true, crossVersionCache: false }, env: {
      ROLE: { type: "text", value: "gateway" }, ELECTRIC_URL: { type: "text", value: electric },
    } } },
  ] })
}, 120_000)
afterAll(async () => { await worker?.dispose() })

const position = (headers: { readonly get: (name: string) => string | null }) => new URLSearchParams({
  handle: headers.get("electric-handle")!, offset: headers.get("electric-offset")!,
  cursor: headers.get("electric-cursor") ?? "", live: "true",
})

test("finite snapshots keep Electric's cache policy only on the private side and never cross person scopes", async () => {
  const gateway = await worker.getWorker("gateway")
  const query = new URLSearchParams({ table, offset: "-1", where: "person = $1", "params[1]": "alice" })
  const upstream = await gateway.fetch(`http://electric-gateway/v1/shape?${query}`)
  expect(upstream.status).toBe(200)
  expect(upstream.headers.get("cache-control")).toContain("public")
  expect(await upstream.text()).toContain("alice-only")
  for (const person of ["alice", "bob"]) {
    const got = await answer(worker, `http://browser/${person}?offset=-1`)
    expect(got.status).toBe(200)
    expect(got.headers.get("cache-control")).toBe("private, no-store")
    expect(got.body).toContain(`${person}-only`)
    expect(got.body).not.toContain(`${person === "alice" ? "bob" : "alice"}-only`)
  }
  const refused = await gateway.fetch("http://electric-gateway/metrics")
  expect(refused.status).toBe(404)
  expect(refused.headers.get("cache-control")).toBe("no-store")
  await refused.text()
})

test("a stale handle is no-store and expired_handle recovery returns the scoped snapshot", async () => {
  const gateway = await worker.getWorker("gateway")
  const query = new URLSearchParams({ table, offset: "0_0", handle: "missing-handle", where: "person = $1", "params[1]": "alice" })
  const stale = await gateway.fetch(`http://electric-gateway/v1/shape?${query}`)
  expect(stale.status).toBe(409)
  expect(stale.headers.get("cache-control")).toBe("no-store")
  await stale.text()
  const recovered = await answer(worker, "http://browser/alice?offset=-1&expired_handle=missing-handle&cache-buster=recovery")
  expect(recovered.status).toBe(200)
  expect(recovered.headers.get("cache-control")).toBe("private, no-store")
  expect(recovered.body).toContain("alice-only")
  expect(recovered.body).not.toContain("bob-only")
})

test("concurrent live readers survive 30 percent aborts and receive the same scoped write", async () => {
  const initial = await answer(worker, "http://browser/alice?offset=-1")
  const query = position(initial.headers)
  const gateway = await worker.getWorker("gateway")
  const count = async () => Number(await (await gateway.fetch("http://gateway/arrivals")).text())
  const before = await count()
  const controllers = Array.from({ length: 10 }, () => new AbortController())
  const reads = controllers.map((controller) => answer(worker, `http://browser/alice?${query}`, { signal: controller.signal })
    .then((value) => ({ value }), () => ({ aborted: true as const })))
  // Abort the initiating caller too. No shared request-owned promise lives in our gateway.
  await expect.poll(count).toBe(before + 10)
  controllers.slice(0, 3).forEach((controller) => controller.abort())
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
    INSERT INTO cache_people VALUES ('write', 'alice', 'live-marker')`))
  const results = await Promise.all(reads)
  expect(results.filter((result) => "aborted" in result)).toHaveLength(3)
  for (const result of results.slice(3)) {
    expect("value" in result).toBe(true)
    if (!("value" in result)) continue
    expect(result.value.status).toBe(200)
    expect(result.value.headers.get("cache-control")).toBe("private, no-store")
    expect(result.value.body).toContain("live-marker")
    expect(result.value.body).not.toContain("bob-only")
  }
}, 60_000)

test("two empty live rounds advance their cursor without losing browser no-store", async () => {
  let previous = await answer(worker, "http://browser/bob?offset=-1")
  for (let round = 0; round < 2; round++) {
    const query = position(previous.headers)
    const next = await answer(worker, `http://browser/bob?${query}`)
    expect(next.status).toBe(200)
    expect(next.headers.get("cache-control")).toBe("private, no-store")
    expect(next.headers.get("electric-cursor")).not.toBe(query.get("cursor"))
    expect(next.body).not.toContain("alice-only")
    previous = next
  }
}, 90_000)
