/**
 * `EdgeCache.layer` inside a Worker in local workerd, over the real `caches`
 * global: what one request stores, a later request reads, byte for byte;
 * a named cache is apart from `caches.default`; an entry over the bound and a
 * failed read are never stored.
 *
 * It needs no database, so unlike `WorkerdSmoke.test.ts` it always runs.
 */
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-unplugin/esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const entry = fileURLToPath(new URL("./workerd/cache-worker.ts", import.meta.url))

let worker: Miniflare

beforeAll(async () => {
  const bundled = await build({
    plugins: [vibelang({ root: fileURLToPath(new URL("..", import.meta.url)) })],
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent"
  })
  worker = new Miniflare({
    workers: [{
      config: {
        name: "edge-cache",
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        manifest: {
          mainModule: "worker.js",
          modules: { "worker.js": { type: "esm", contents: bundled.outputFiles[0]!.text } }
        }
      }
    }]
  })
}, 120_000)

afterAll(() => worker?.dispose())

const call = async (
  path: string,
  init: { readonly method?: string; readonly body?: Uint8Array; readonly headers?: Record<string, string> } = {}
) => {
  const response = await worker.dispatchFetch(`http://edge-cache${path}`, init)
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

const every = Uint8Array.from({ length: 256 }, (_, index) => index)

describe("EdgeCache.layer in workerd", () => {
  it("answers a later request with exactly the bytes and metadata an earlier one stored", async () => {
    expect(await call("/get?path=a.bin")).toEqual({ hit: false })
    expect(
      await call("/put?path=a.bin", { method: "POST", body: every, headers: { "x-metadata": "{\"blobSha\":\"b\"}" } })
    )
      .toEqual({ outcome: "stored" })
    expect(await call("/get?path=a.bin")).toEqual({ hit: true, bytes: [...every], metadata: { blobSha: "b" } })
  })

  it("keeps a named cache apart from caches.default", async () => {
    expect(await call("/put?path=named.bin&cache=repo", { method: "POST", body: every })).toEqual({ outcome: "stored" })
    expect(await call("/get?path=named.bin&cache=repo")).toMatchObject({ hit: true })
    expect(await call("/get?path=named.bin")).toEqual({ hit: false })
  })

  it("stores nothing over the entry bound", async () => {
    expect(await call("/put?path=big.bin", { method: "POST", body: new Uint8Array(1025) }))
      .toEqual({ outcome: "too_large" })
    expect(await call("/get?path=big.bin")).toEqual({ hit: false })
  })

  it("reads through: a failure is never stored, and a stored value answers every later read", async () => {
    expect(await call("/through?path=t.txt&fail=1")).toEqual({ failed: true })
    expect(await call("/get?path=t.txt")).toEqual({ hit: false })
    const first = await call("/through?path=t.txt")
    expect(typeof first.value).toBe("string")
    // The source answers a new random value each time, so the same value means the cache answered.
    expect(await call("/through?path=t.txt")).toEqual(first)
    expect(await call("/through?path=t.txt&fail=1")).toEqual(first)
  })
})
