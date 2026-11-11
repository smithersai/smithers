import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openCache, type CachedResult } from "../../../build-cli/src/Cache.ts"
import * as Tree from "../../../build-cli/src/PackageTree.ts"
import { createHandler } from "../protocol.ts"
import { MemoryActionCache, MemoryContentStore } from "./MemoryStores.ts"

const roots: Array<string> = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => Fs.rm(root, { recursive: true, force: true }))) })
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const read = "test-read-credential-for-output-faults", write = "test-write-credential-for-output-faults"
const fresh = async () => { const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "output-faults-"))); roots.push(root); return root }

const fixture = async (large = false, shortDeadline: boolean | { readonly get: number; readonly put: number } = false) => {
  const a = await fresh(), b = await fresh()
  const actionCache = new MemoryActionCache(), contentStore = new MemoryContentStore()
  const handler = createHandler({ actionCache, contentStore, readTokenHash: hash(read), writeTokenHash: hash(write) })
  const warnings: Array<string> = []
  let fault: (request: Request, signal?: AbortSignal | null) => Response | Promise<Response> | undefined = () => undefined
  let active = 0, peak = 0
  const open = (root: string) => openCache({
    workspaceRoot: root, endpoint: "https://cache.test", readToken: () => read, writeToken: () => write,
    ...(shortDeadline ? { timeouts: typeof shortDeadline === "boolean" ? { get: 100, put: 500 } : shortDeadline } : {}), warn: line => warnings.push(line),
    fetch: async (input, init) => {
      const request = new Request(input, init), isBlob = new URL(request.url).pathname.startsWith("/cas/")
      if (isBlob) { active++; peak = Math.max(peak, active) }
      try { return await (fault(request, init?.signal) ?? handler(request)) }
      finally { if (isBlob) active-- }
    }
  })
  await Fs.writeFile(Path.join(a, "program"), large ? Buffer.alloc(16 * 1024 * 1024 + 1, 7) : "bytes")
  const file = await Tree.captureFile(a, ".flows", "program")
  const result: CachedResult = { key: "a".repeat(64), target: "Build", label: "//:build", exitOk: true,
    storedAt: "2026-01-01T00:00:00.000Z", output: { kind: "build", manifests: [], files: [file] } }
  return { a, b, file, result, actionCache, contentStore, handler, warnings, open, setFault: (f: typeof fault) => { fault = f }, peak: () => peak }
}

describe("remote output failure boundaries", () => {
  it.each([undefined, null, "invalid", 0.25, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001])(
    "keeps the canonical receipt when the remote publication time is invalid: %s", async createdAtMs => {
      const f = await fixture()
      await (await f.open(f.a)).put(f.result.key, f.result)
      f.setFault(async req => {
        if (req.method !== "GET" || !new URL(req.url).pathname.startsWith("/ac/")) return f.handler(req)
        const body = await (await f.handler(req)).json() as Record<string, unknown>
        if (createdAtMs === undefined) delete body["createdAtMs"]
        else body["createdAtMs"] = createdAtMs
        return Response.json(body)
      })
      const hit = await (await f.open(f.b)).get(f.result.key)
      expect(hit?.storedAt).toBe("1970-01-01T00:00:00.000Z")
      expect(await Tree.verifyFileManifest(f.b, ".flows", f.file)).toBeUndefined()
      expect(f.warnings).toEqual([])
    }
  )
  it("skips one busy download and restores on the next lookup", async () => {
    const f = await fixture()
    await (await f.open(f.a)).put(f.result.key, f.result)
    let refused = false
    f.setFault(req => {
      if (!refused && req.method === "GET" && new URL(req.url).pathname.startsWith("/cas/")) {
        refused = true
        return new Response(null, { status: 429 })
      }
    })
    const reader = await f.open(f.b)
    expect(await reader.get(f.result.key)).toBeNull()
    expect(await reader.get(f.result.key)).not.toBeNull()
    expect(await Tree.verifyFileManifest(f.b, ".flows", f.file)).toBeUndefined()
    expect(f.warnings).toEqual(["smthrs: remote cache busy (HTTP 429); skipped one request"])
  })
  it.each(["oversized", "truncated", "corrupt", "hang"])("rejects a %s response before publishing a local blob", async kind => {
    const f = await fixture(false, kind === "hang")
    await (await f.open(f.a)).put(f.result.key, f.result)
    f.setFault(req => {
      if (req.method !== "GET" || !new URL(req.url).pathname.startsWith("/cas/")) return
      if (kind === "hang") return new Promise<Response>(() => {})
      if (kind === "oversized") return new Response("small", { headers: { "content-length": String(16 * 1024 * 1024 + 1) } })
      if (kind === "truncated") return new Response("small", { headers: { "content-length": "10" } })
      return new Response("wrong digest")
    })
    const reader = await f.open(f.b)
    expect(await reader.get(f.result.key)).toBeNull()
    expect(await reader.get(f.result.key)).toBeNull()
    expect(f.warnings).toHaveLength(1)
    expect(await Fs.readdir(Path.join(f.b, ".flows/cas"))).toEqual([])
  })
  it("refuses an unrequested missing digest and never publishes metadata", async () => {
    const f = await fixture()
    f.setFault(req => new URL(req.url).pathname.endsWith("/findMissing")
      ? Response.json({ missing: ["b".repeat(64)] }) : undefined)
    const cache = await f.open(f.a)
    await cache.put(f.result.key, f.result)
    expect(f.actionCache.entries.size).toBe(0)
    expect(f.contentStore.objects.size).toBe(0)
    expect(f.warnings).toHaveLength(1)
    expect(await cache.get(f.result.key)).not.toBeNull()
  })
  it("hydrates a legacy local manifest through the remote index after local CAS loss", async () => {
    const f = await fixture(true), cache = await f.open(f.a)
    await cache.put(f.result.key, f.result)
    await Fs.rm(Path.join(f.a, ".flows/cas"), { recursive: true })
    expect(await cache.get(f.result.key)).not.toBeNull()
    expect(await Tree.verifyFileManifest(f.a, ".flows", f.file)).toBeUndefined()
    expect(f.warnings).toEqual([])
  })
  it("bounds transfers across simultaneous target publications and restores", async () => {
    const f = await fixture(true), publisher = await f.open(f.a)
    const results = Array.from({ length: 4 }, (_, i) => ({ ...f.result, key: String(i).repeat(64) }))
    await Promise.all(results.map(result => publisher.put(result.key, result)))
    const reader = await f.open(f.b)
    expect((await Promise.all(results.map(result => reader.get(result.key)))).every(Boolean)).toBe(true)
    expect(f.peak()).toBe(1)
    expect(f.warnings).toEqual([])
  })
})

it("skips an over-limit publication and keeps remote operations available", async () => {
  const f = await fixture(), cache = await f.open(f.a)
  const files: Array<{ path: string; digest: string; executable: boolean }> = []
  for (let n = 0; n < 1001; n++) {
    const text = String(n), digest = hash(text)
    await Fs.writeFile(Path.join(f.a, ".flows/cas", digest), text)
    files.push({ path: String(n), digest, executable: false })
  }
  const large = { ...f.result, key: "b".repeat(64), output: { kind: "build", manifests: [], files } }
  await cache.put(large.key, large)
  await cache.put(large.key, large)
  expect(f.actionCache.entries.size).toBe(0)
  expect(f.warnings).toHaveLength(1)
  await cache.put(f.result.key, f.result)
  expect(f.actionCache.entries.has(f.result.key)).toBe(true)
  expect(await (await f.open(f.b)).get(f.result.key)).not.toBeNull()
})

it("retains local metadata when its output files can be measured during a remote outage", async () => {
  const f = await fixture(), cache = await f.open(f.a)
  await cache.put(f.result.key, f.result)
  await Fs.rm(Path.join(f.a, ".flows/cas"), { recursive: true })
  f.setFault(() => new Response(null, { status: 503 }))
  expect(await cache.get(f.result.key)).toEqual(f.result)
  expect(await Fs.readFile(Path.join(f.a, "program"), "utf8")).toBe("bytes")
})

it("gives an artifact transfer longer than the action-cache metadata deadline", async () => {
  const f = await fixture()
  await (await f.open(f.a)).put(f.result.key, f.result)
  f.setFault(request => {
    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/cas/")) {
      // A real delayed service response proves the artifact race has its own budget.
      return new Promise<Response>(resolve => { setTimeout(() => { void f.handler(request).then(resolve) }, 3200) })
    }
  })
  expect(await (await f.open(f.b)).get(f.result.key)).not.toBeNull()
  expect(f.warnings).toEqual([])
})

it("skips an over-limit remote entry and can still read an unrelated valid hit", async () => {
  const f = await fixture()
  const files = []
  for (let n = 0; n < 5; n++) {
    const digest = String(n + 1).repeat(64)
    const bytes = Buffer.from(JSON.stringify({
      kind: "smithers-build/chunks-v1", size: 4 * 1024 * 1024 * 1024,
      chunks: Array.from({ length: 256 }, () => ({ digest, size: 16 * 1024 * 1024 }))
    }))
    const index = createHash("sha256").update(bytes).digest("hex")
    await f.contentStore.put(index, new Uint8Array(bytes))
    files.push({ path: "file-" + n, executable: false, digest, index })
  }
  const result = { ...f.result, key: "b".repeat(64), output: { kind: "build", manifests: [], files } }
  const response = await f.handler(new Request("https://cache.test/ac/" + result.key, {
    method: "PUT", headers: { authorization: "Bearer " + write, "content-type": "application/json" },
    body: JSON.stringify({ keyDigest: result.key, result })
  }))
  expect(response.status).toBe(201)
  await response.text()
  const cache = await f.open(f.b)
  expect(await cache.get(result.key)).toBeNull()
  await (await f.open(f.a)).put(f.result.key, f.result)
  expect(await cache.get(f.result.key)).not.toBeNull()
  expect(f.warnings).toEqual(["smthrs: remote cache entry exceeds limits; skipped one entry"])
})

it("keeps an entry above the metadata bound local and publishes the next valid entry", async () => {
  const f = await fixture(), cache = await f.open(f.a)
  const result = { ...f.result, key: "b".repeat(64), output: "x".repeat(1024 * 1024) }
  await cache.put(result.key, result)
  expect(f.actionCache.entries.size).toBe(0)
  expect(f.contentStore.objects.size).toBe(0)
  expect(await cache.get(result.key)).toEqual(result)
  await cache.put(f.result.key, f.result)
  expect(await (await f.open(f.b)).get(f.result.key)).not.toBeNull()
  expect(f.warnings).toEqual(["smthrs: remote cache entry exceeds limits; skipped one entry"])
})

it("allows a bulk probe beyond the metadata deadline", async () => {
  const f = await fixture()
  let calls = 0
  f.setFault(async request => {
    if (new URL(request.url).pathname.endsWith("/findMissing")) {
      calls++
      await new Promise(resolve => setTimeout(resolve, 3200))
    }
    return f.handler(request)
  })
  const cache = await f.open(f.a)
  await cache.put(f.result.key, f.result)
  expect(f.actionCache.entries.has(f.result.key)).toBe(true)
  expect(calls).toBe(1)
  expect(await (await f.open(f.b)).get(f.result.key)).not.toBeNull()
  expect(f.warnings).toEqual([])
})

it.each(["request", "body"])("races a hung bulk %s against an explicit timeout", async stage => {
  const f = await fixture(false, true)
  let signal: AbortSignal | undefined
  f.setFault((request, transportSignal) => {
    if (!new URL(request.url).pathname.endsWith("/findMissing")) return
    signal = transportSignal ?? undefined
    return stage === "request"
      ? new Promise<Response>(() => {})
      : new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"missing":[')) } }))
  })
  const cache = await f.open(f.a)
  const start = performance.now()
  await cache.put(f.result.key, f.result)
  expect(performance.now() - start).toBeLessThan(2000)
  expect(signal?.aborted).toBe(true)
  expect(f.actionCache.entries.size).toBe(0)
  expect(f.warnings).toHaveLength(1)
  expect(f.warnings[0]).toContain("findMissing timed out after 100ms")
  expect(await cache.get(f.result.key)).not.toBeNull()
  await cache.put(f.result.key, f.result)
  expect(f.warnings).toHaveLength(1)
})

it("skips a busy later probe, then publishes every blob before metadata on retry", async () => {
  const f = await fixture()
  await Fs.mkdir(Path.join(f.a, "out"))
  for (let i = 0; i < 129; i++) await Fs.writeFile(Path.join(f.a, "out", String(i)), String(i))
  const manifest = await Tree.captureOutDir(f.a, ".flows", "out")
  const result = { ...f.result, output: { kind: "build", manifests: [manifest], files: [] } }
  let probes = 0
  f.setFault(request => {
    if (new URL(request.url).pathname.endsWith("/findMissing") && ++probes === 2) return new Response(null, { status: 429 })
  })
  const cache = await f.open(f.a)
  await cache.put(result.key, result)
  expect(f.actionCache.entries.size).toBe(0)
  expect(f.contentStore.objects.size).toBe(128)
  expect(await cache.get(result.key)).not.toBeNull()
  await cache.put(result.key, result)
  expect(f.actionCache.entries.size).toBe(1)
  expect(f.contentStore.objects.size).toBe(129)
  expect(await (await f.open(f.b)).get(result.key)).not.toBeNull()
  expect(await Tree.verifyManifestBlobs(f.b, ".flows", manifest)).toBeUndefined()
  expect(f.warnings).toEqual(["smthrs: remote cache busy (HTTP 429); skipped one request"])
})

it("scales a full discovery batch deadline and still races an uncooperative backend", async () => {
  const f = await fixture(false, { get: 5000, put: 100 })
  await Fs.mkdir(Path.join(f.a, "out"))
  for (let i = 0; i < 128; i++) await Fs.writeFile(Path.join(f.a, "out", String(i)), String(i))
  const manifest = await Tree.captureOutDir(f.a, ".flows", "out")
  const result = { ...f.result, output: { kind: "build", manifests: [manifest], files: [] } }
  let signal: AbortSignal | undefined
  f.setFault((request, transportSignal) => {
    if (!new URL(request.url).pathname.endsWith("/findMissing")) return
    signal = transportSignal ?? undefined
    return new Promise<Response>(() => {})
  })
  const cache = await f.open(f.a)
  const start = performance.now()
  await cache.put(result.key, result)
  expect(performance.now() - start).toBeGreaterThanOrEqual(3200)
  expect(performance.now() - start).toBeLessThan(8000)
  expect(signal?.aborted).toBe(true)
  expect(f.actionCache.entries.size).toBe(0)
  expect(f.contentStore.objects.size).toBe(0)
  expect(await cache.get(result.key)).not.toBeNull()
  expect(f.warnings).toEqual([
    "smthrs: remote cache disabled after a failure: PUT request failed: remote cache findMissing timed out after 3300ms"
  ])
}, 30000)
