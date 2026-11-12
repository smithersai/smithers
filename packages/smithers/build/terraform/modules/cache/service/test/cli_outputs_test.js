/** Real CLI and both deployed protocol handlers, including chunk-boundary properties. */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { openCache } from "../../../../../build-cli/src/Cache.ts"
import * as Tree from "../../../../../build-cli/src/PackageTree.ts"
import { createHandler as worker } from "../../../../../infra/worker/protocol.ts"
import { MemoryActionCache, MemoryContentStore } from "../../../../../infra/worker/test/MemoryStores.ts"
import { createHandler as service } from "../protocol.js"

const hash = (value) => createHash("sha256").update(value).digest("hex")
const reader = "reader-credential-for-cli-output-tests"
const writer = "writer-credential-for-cli-output-tests"
const chunkBytes = 16 * 1024 * 1024

for (const [name, make] of [["hosted", worker], ["self-hosted", service]]) {
  describe(name + " CLI output conformance", () => {
    const run = async (size, exercise = async () => {}) => {
      const actionCache = new MemoryActionCache(), contentStore = new MemoryContentStore()
      const handler = make({
        actionCache,
        contentStore,
        readTokenHash: hash(reader),
        writeTokenHash: hash(writer),
        maxArtifactBytes: chunkBytes
      })
      const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "cli-output-conformance-")))
      const a = Path.join(root, "a"), b = Path.join(root, "b")
      const statuses = [], warnings = []
      let fault = () => undefined
      const open = (workspaceRoot, token = writer, timeouts) =>
        openCache({
          workspaceRoot,
          endpoint: "https://cache.test",
          ...(timeouts === undefined ? {} : { timeouts }),
          readToken: () => reader,
          writeToken: () => token,
          warn: (line) => warnings.push(line),
          fetch: async (input, init) => {
            const req = new Request(input, init)
            const response = await (fault(req) ?? handler(req))
            statuses.push([req.method, new URL(req.url).pathname, response.status])
            return response
          }
        })
      try {
        await Fs.mkdir(a)
        await Fs.mkdir(b)
        const handle = await Fs.open(Path.join(a, "program"), "w", 0o755)
        try {
          for (let offset = 0; offset < size; offset += 65536) {
            await handle.write(Buffer.alloc(Math.min(65536, size - offset), Math.floor(offset / 65536) % 251))
          }
        } finally {
          await handle.close()
        }
        const file = await Tree.captureFile(a, ".flows", "program")
        const result = {
          key: "f".repeat(64),
          target: "ToolBuild",
          label: "//:program",
          exitOk: true,
          storedAt: "2026-01-01T00:00:00.000Z",
          output: { kind: "target-outputs", result: { value: null }, manifests: [], files: [file] }
        }
        await exercise({
          a,
          b,
          file,
          result,
          open,
          actionCache,
          contentStore,
          handler,
          statuses,
          warnings,
          setFault: (value) => {
            fault = value
          }
        })
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }
    test("publishes 520 files through bounded probes and restores their bytes and modes", async () => {
      await run(1, async (f) => {
        await Fs.mkdir(Path.join(f.a, "out"))
        for (let i = 0; i < 520; i++) {
          await Fs.writeFile(Path.join(f.a, "out", String(i)), "artifact-" + i, { mode: i % 2 ? 0o755 : 0o644 })
        }
        const manifest = await Tree.captureOutDir(f.a, ".flows", "out")
        const result = { ...f.result, output: { kind: "build", manifests: [manifest], files: [] } }
        const batches = []
        f.setFault(async (req) => {
          if (!new URL(req.url).pathname.endsWith("/findMissing")) return f.handler(req)
          const { digests } = await req.clone().json()
          batches.push(digests.length)
          // Backend latency proportional to the requested object count.
          await new Promise((resolve) => setTimeout(resolve, digests.length * 8))
          return f.handler(req)
        })
        await (await f.open(f.a)).put(result.key, result)
        expect(f.actionCache.entries.has(result.key)).toBe(true)
        expect(batches).toEqual([128, 128, 128, 128, 8])
        const hit = await (await f.open(f.b)).get(result.key)
        expect(hit).not.toBeNull()
        expect(await Tree.verifyManifestBlobs(f.b, ".flows", manifest)).toBeUndefined()
        await Tree.materializeManifest(f.b, ".flows", manifest)
        for (let i = 0; i < 520; i++) {
          expect(await Fs.readFile(Path.join(f.b, "out", String(i)), "utf8")).toBe("artifact-" + i)
          expect((await Fs.stat(Path.join(f.b, "out", String(i)))).mode & 0o777).toBe(i % 2 ? 0o755 : 0o644)
        }
        expect(f.warnings).toEqual([])
        expect(f.statuses.filter(([method]) => method === "PUT").at(-1)[1]).toMatch(/^\/ac\//)
      })
    }, 30000)

    test("file-size property around every chunk boundary and a 40 MiB file", async () => {
      // Reproducible neighbourhood generator: boundary multiples and seeded offsets.
      let seed = 0x5eedcafe
      const sizes = new Set([0, 1, 40 * 1024 * 1024])
      for (const boundary of [1, 2]) for (const delta of [-1, 0, 1]) sizes.add(boundary * chunkBytes + delta)
      for (let i = 0; i < 6; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        sizes.add((1 + seed % 2) * chunkBytes + ((seed >>> 8) % 17) - 8)
      }
      for (const size of sizes) {
        await run(size, async (f) => {
          const publisher = await f.open(f.a)
          await publisher.put(f.result.key, f.result)
          expect(f.actionCache.entries.size).toBe(1)
          // A second independent timestamp must not change the result identity.
          await publisher.put(f.result.key, { ...f.result, storedAt: "2026-02-01T00:00:00.000Z" })
          expect(f.statuses.filter(([m, p]) => m === "PUT" && p.startsWith("/ac/")).map((r) => r[2])).toEqual([
            201,
            200
          ])
          const hit = await (await f.open(f.b)).get(f.result.key)
          expect(hit).not.toBeNull()
          expect(hit.storedAt).toBe(f.result.storedAt)
          expect(await Tree.verifyFileManifest(f.b, ".flows", f.file)).toBeUndefined()
          await Tree.materializeFile(f.b, ".flows", f.file)
          expect(await Tree.digestFileBytes(Path.join(f.b, "program"))).toBe(f.file.digest)
          expect((await Fs.stat(Path.join(f.b, "program"))).size).toBe(size)
          expect((await Fs.stat(Path.join(f.b, "program"))).mode & 0o777).toBe(0o755)
          expect([...f.contentStore.objects.values()].every((b) => b.length <= chunkBytes)).toBe(true)
          expect(f.warnings).toEqual([])
          // Every direct index/chunk reference is visible to retention.
          const body = JSON.parse(f.actionCache.entries.get(f.result.key).body)
          expect(new Set(body.meta.boundary.declaredOutputs.outputs.map((o) => o.digest))).toEqual(
            new Set(f.contentStore.objects.keys())
          )
        })
      }
    }, 120000)

    test("one slow findMissing costs one publication and keeps the remote", async () => {
      await run(1, async (f) => {
        await Fs.writeFile(Path.join(f.a, "other"), "other bytes")
        const other = await Tree.captureFile(f.a, ".flows", "other")
        const fast = { ...f.result, key: "e".repeat(64), output: { kind: "build", manifests: [], files: [other] } }
        f.setFault(async (req) => {
          if (!new URL(req.url).pathname.endsWith("/findMissing")) return f.handler(req)
          const { digests } = await req.clone().json()
          // Latency injected in transport: this entry's probe always outlives its deadline.
          if (digests.includes(f.file.digest)) await new Promise((resolve) => setTimeout(resolve, 400))
          return f.handler(req)
        })
        const cache = await f.open(f.a, writer, { get: 5000, put: 100 })
        await cache.put(f.result.key, f.result)
        await cache.put(fast.key, fast)
        expect(f.actionCache.entries.has(f.result.key)).toBe(false)
        expect(f.actionCache.entries.has(fast.key)).toBe(true)
        expect(f.warnings).toEqual(["smthrs: remote cache findMissing timed out; skipped one publication"])
        expect(await (await f.open(f.b)).get(fast.key)).not.toBeNull()
        expect(await Tree.verifyFileManifest(f.b, ".flows", other)).toBeUndefined()
      })
    }, 30000)

    for (const kind of ["missing", "corrupt", "busy", "down", "reader"]) {
      test(kind + " retains local data and never publishes a partial result", async () => {
        await run(40 * 1024 * 1024, async (f) => {
          if (kind === "reader" || kind === "busy" || kind === "down") {
            // A busy service stays busy through the first publication's retries.
            let failing = true
            f.setFault((req) => {
              if (
                failing && req.method === "PUT" && new URL(req.url).pathname.startsWith("/cas/") && kind !== "reader"
              ) {
                if (kind === "down") failing = false
                return new Response(null, { status: kind === "busy" ? 429 : 503 })
              }
            })
            const cache = await f.open(f.a, kind === "reader" ? reader : writer)
            await cache.put(f.result.key, f.result)
            failing = false
            expect(f.actionCache.entries.size).toBe(0)
            expect(await cache.get(f.result.key)).not.toBeNull()
            await cache.put(f.result.key, f.result)
            expect(f.actionCache.entries.size).toBe(kind === "busy" ? 1 : 0)
            expect(f.warnings.length).toBe(1)
          } else {
            await (await f.open(f.a)).put(f.result.key, f.result)
            const chunk = [...f.contentStore.objects].find(([, bytes]) => bytes.length === chunkBytes)
            expect(chunk).toBeDefined()
            if (kind === "missing") f.contentStore.objects.delete(chunk[0])
            else f.contentStore.objects.set(chunk[0], new Uint8Array([1, 2, 3]))
            expect(await (await f.open(f.b)).get(f.result.key)).toBeNull()
            await expect(Fs.stat(Path.join(f.b, "program"))).rejects.toMatchObject({ code: "ENOENT" })
            expect((await Fs.readdir(Path.join(f.b, ".flows/cas"))).some((p) => p.includes(".tmp-"))).toBe(false)
          }
        })
      })
    }
  })
}
