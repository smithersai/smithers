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
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const reader = "reader-credential-for-real-handler-tests"
const writer = "writer-credential-for-real-handler-tests"
const fresh = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "remote-outputs-")))
  roots.push(root)
  return root
}
const fixture = async () => {
  const actionCache = new MemoryActionCache()
  const contentStore = new MemoryContentStore()
  const handler = createHandler({ actionCache, contentStore, readTokenHash: hash(reader), writeTokenHash: hash(writer) })
  const requests: Array<{ path: string; method: string; status: number }> = []
  const warnings: Array<string> = []
  const open = (root: string, token = writer, fault?: (request: Request) => Response | undefined) => openCache({
    workspaceRoot: root, endpoint: "https://cache.test",
    readToken: () => reader, writeToken: () => token, warn: line => warnings.push(line),
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const response = fault?.(request) ?? await handler(request)
      requests.push({ path: new URL(request.url).pathname, method: request.method, status: response.status })
      return response
    }
  })
  return { actionCache, contentStore, requests, warnings, open }
}
const capture = async (root: string, size: number): Promise<CachedResult> => {
  await Fs.mkdir(Path.join(root, "out"), { recursive: true })
  const handle = await Fs.open(Path.join(root, "out/program"), "w", 0o755)
  try {
    // Distinct chunks expose ordering and duplication errors, without a whole-file allocation.
    for (let offset = 0; offset < size; offset += 1024 * 1024) {
      await handle.write(Buffer.alloc(Math.min(1024 * 1024, size - offset), (offset / (1024 * 1024)) % 251))
    }
  } finally { await handle.close() }
  return { key: "a".repeat(64), target: "Build", label: "//:build", exitOk: true,
    storedAt: "2026-01-01T00:00:00.000Z",
    output: { kind: "build", manifests: [await Tree.captureOutDir(root, ".flows", "out")], files: [] } }
}
const restore = async (root: string, output: unknown) => {
  const manifest = Tree.decodeManifest((output as { manifests: Array<unknown> }).manifests[0])
  expect(manifest).toBeDefined()
  expect(await Tree.verifyManifestBlobs(root, ".flows", manifest!)).toBeUndefined()
  await Tree.materializeManifest(root, ".flows", manifest!)
}

describe("remote output blobs", () => {
  it.each([7, 40 * 1024 * 1024])("restores %i bytes and executable mode on a fresh machine", async size => {
    const f = await fixture(), a = await fresh(), b = await fresh()
    const result = await capture(a, size)
    await (await f.open(a)).put(result.key, result)
    expect(f.actionCache.entries.has(result.key)).toBe(true)
    const hit = await (await f.open(b)).get(result.key)
    expect(hit).not.toBeNull()
    expect(hit!.storedAt).toBe(result.storedAt)
    await restore(b, hit!.output)
    expect(await Tree.digestFileBytes(Path.join(b, "out/program"))).toBe(await Tree.digestFileBytes(Path.join(a, "out/program")))
    expect((await Fs.stat(Path.join(b, "out/program"))).mode & 0o777).toBe(0o755)
    expect(f.requests.filter(r => r.method === "PUT").at(-1)?.path).toMatch(/^\/ac\//)
    expect([...f.contentStore.objects.values()].every(bytes => bytes.length <= 16 * 1024 * 1024)).toBe(true)
    expect(f.warnings).toEqual([])
  })
  it.each(["missing", "corrupt"])("treats a %s chunk as a miss without partial output", async fault => {
    const f = await fixture(), a = await fresh(), b = await fresh()
    const result = await capture(a, 40 * 1024 * 1024)
    await (await f.open(a)).put(result.key, result)
    const chunk = [...f.contentStore.objects].find(([, bytes]) => bytes.length === 16 * 1024 * 1024)
    expect(chunk).toBeDefined()
    if (fault === "missing") f.contentStore.objects.delete(chunk![0])
    else f.contentStore.objects.set(chunk![0], new Uint8Array([1, 2, 3]))
    expect(await (await f.open(b)).get(result.key)).toBeNull()
    await expect(Fs.stat(Path.join(b, "out/program"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await Fs.readdir(Path.join(b, ".flows/cas"))).filter(name => name.includes(".tmp"))).toEqual([])
  })
  it("publishes nothing with a reader credential, warns once, and retains local results", async () => {
    const f = await fixture(), a = await fresh()
    const result = await capture(a, 10), cache = await f.open(a, reader)
    await cache.put(result.key, result)
    await cache.put(result.key, result)
    expect(f.actionCache.entries.size).toBe(0)
    expect(f.contentStore.objects.size).toBe(0)
    expect(f.warnings).toEqual(["smthrs: remote cache publication refused; this credential may only read"])
    expect(await cache.get(result.key)).not.toBeNull()
  })
  it.each([429, 503])("does not publish metadata after upload HTTP %i", async status => {
    const f = await fixture(), a = await fresh()
    const result = await capture(a, 40 * 1024 * 1024)
    // A 503 fails once; a busy service stays busy through the first put's retries.
    let failing = true
    const cache = await f.open(a, writer, request => {
      if (failing && request.method === "PUT" && new URL(request.url).pathname.startsWith("/cas/")) {
        if (status === 503) failing = false
        return new Response(null, { status })
      }
      return undefined
    })
    await cache.put(result.key, result)
    failing = false
    expect(f.actionCache.entries.size).toBe(0)
    expect(await cache.get(result.key)).not.toBeNull()
    if (status === 429) {
      await cache.put(result.key, result)
      expect(f.actionCache.entries.size).toBe(1)
    } else {
      await cache.put(result.key, result)
      expect(f.actionCache.entries.size).toBe(0)
    }
    expect(f.warnings).toHaveLength(1)
  })
  it("restores a pre-chunking local entry without remote traffic", async () => {
    const a = await fresh()
    const result = await capture(a, 40 * 1024 * 1024)
    const cache = await openCache({ workspaceRoot: a })
    await cache.put(result.key, result)
    await Fs.rm(Path.join(a, "out"), { recursive: true })
    await restore(a, (await cache.get(result.key))!.output)
    expect((await Fs.stat(Path.join(a, "out/program"))).size).toBe(40 * 1024 * 1024)
  })
})

it.each([7, 40 * 1024 * 1024])("hydrates a %i-byte Go archive blob from the remote", async size => {
  const f = await fixture(), a = await fresh(), b = await fresh()
  const result = await capture(a, size)
  const digest = ((result.output as { manifests: Array<{ entries: Array<{ digest: string }> }> }).manifests[0]!.entries[0]!).digest
  const archive = { ...result, output: { kind: "directory-archive", outDir: ".gomodcache", digest } }
  await (await f.open(a)).put(archive.key, archive)
  expect(await (await f.open(b)).get(archive.key)).not.toBeNull()
  expect(await Tree.digestFileBytes(Path.join(b, ".flows/cas", digest))).toBe(digest)
  expect(f.warnings).toEqual([])
})

it("restores a non-executable binary file with the same bytes and mode", async () => {
  const f = await fixture(), a = await fresh(), b = await fresh()
  const bytes = Buffer.from([0, 255, 17, 128])
  await Fs.writeFile(Path.join(a, "data"), bytes)
  await Fs.chmod(Path.join(a, "data"), 0o644)
  const file = await Tree.captureFile(a, ".flows", "data")
  const result: CachedResult = {
    key: "c".repeat(64), target: "Build", label: "//:data", exitOk: true,
    storedAt: "2026-01-01T00:00:00.000Z",
    output: { kind: "build", manifests: [], files: [file] }
  }
  await (await f.open(a)).put(result.key, result)
  expect(await (await f.open(b)).get(result.key)).not.toBeNull()
  expect(await Tree.verifyFileManifest(b, ".flows", file)).toBeUndefined()
  await Tree.materializeFile(b, ".flows", file)
  expect(await Fs.readFile(Path.join(b, "data"))).toEqual(bytes)
  expect((await Fs.stat(Path.join(b, "data"))).mode & 0o777).toBe((await Fs.stat(Path.join(a, "data"))).mode & 0o777)
})
