import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  chunkBytes,
  hasFile,
  hydrate,
  makeLimiter,
  makeOutputBudget,
  prepare,
  readBlob,
  readIndex,
  writeBlob
} from "../src/internal/OutputCas.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})
const fresh = async () => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "output-cas-"))
  roots.push(root)
  return root
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const fileOutput = (digest: string, index?: string) => ({
  kind: "build",
  manifests: [],
  files: [{ path: "program", digest, ...(index === undefined ? {} : { index }), executable: false }]
})
const storeIndex = async (cas: string, index: unknown) => {
  const bytes = Buffer.from(JSON.stringify(index)), digest = hash(bytes)
  await writeBlob(cas, digest, bytes)
  return digest
}

describe("bounded output CAS", () => {
  it("verifies content, rejects non-files and symlinks, and heals corrupt blobs atomically", async () => {
    const cas = await fresh(), bytes = Buffer.from("hello"), digest = hash(bytes)
    expect(await hasFile(cas, digest)).toBe(false)
    await writeBlob(cas, digest, bytes)
    expect(await hasFile(cas, digest)).toBe(true)
    expect(await readBlob(cas, digest)).toEqual(bytes)
    await expect(readBlob(cas, "invalid")).rejects.toThrow("invalid CAS digest")
    await expect(readBlob(cas, digest, 1)).rejects.toThrow("transfer bound")
    await expect(writeBlob(cas, "invalid", bytes)).rejects.toThrow("verification")
    await expect(writeBlob(cas, digest, Buffer.from("bad"))).rejects.toThrow("verification")
    await Fs.writeFile(Path.join(cas, digest), "bad")
    expect(await hasFile(cas, digest)).toBe(false)
    await expect(readBlob(cas, digest)).rejects.toThrow("verification")
    await writeBlob(cas, digest, bytes)
    expect(await readBlob(cas, digest)).toEqual(bytes)
    await Fs.unlink(Path.join(cas, digest))
    await Fs.mkdir(Path.join(cas, digest))
    await expect(readBlob(cas, digest)).rejects.toThrow("regular file")
    await Fs.rmdir(Path.join(cas, digest))
    await Fs.writeFile(Path.join(cas, "other"), bytes)
    await Fs.symlink("other", Path.join(cas, digest))
    expect(await hasFile(cas, digest)).toBe(false)
    await expect(readBlob(cas, digest)).rejects.toThrow("regular file")
  })
  it("removes aborted and failed publication temporaries", async () => {
    const cas = await fresh(), bytes = Buffer.from("hello"), digest = hash(bytes)
    await expect(writeBlob(cas, digest, bytes, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled")
    expect(await Fs.readdir(cas)).toEqual([])
    await Fs.mkdir(Path.join(cas, digest))
    await expect(writeBlob(cas, digest, bytes)).rejects.toThrow()
    expect(await Fs.readdir(cas)).toEqual([digest])
    const sparse = "0".repeat(64)
    await Fs.writeFile(Path.join(cas, sparse), "")
    await Fs.truncate(Path.join(cas, sparse), 4 * 1024 * 1024 * 1024 + 1)
    await expect(readBlob(cas, sparse)).rejects.toThrow("file bound")
  })
  it.each([
    null,
    {},
    { kind: "other" },
    { kind: "smithers-build/chunks-v1", size: chunkBytes, chunks: [] },
    { kind: "smithers-build/chunks-v1", size: chunkBytes + 1, chunks: [] },
    { kind: "smithers-build/chunks-v1", size: chunkBytes + 1, chunks: [null, null] },
    {
      kind: "smithers-build/chunks-v1",
      size: chunkBytes + 1,
      chunks: [{ digest: "bad", size: chunkBytes }, { digest: "0".repeat(64), size: 1 }]
    }
  ])("rejects invalid index %#", async (index) => {
    const cas = await fresh(), digest = await storeIndex(cas, index)
    await expect(readIndex(cas, digest)).rejects.toThrow()
  })
  it.each([
    { kind: "build" },
    { kind: "build", manifests: 1 },
    { kind: "build", manifests: [], files: false },
    { kind: "build", manifests: [null] },
    { kind: "build", manifests: [], files: [null] },
    { kind: "build", manifests: [], files: [{ digest: "bad" }] },
    { kind: "build", manifests: [], files: [{ digest: "0".repeat(64), index: "bad" }] }
  ])("rejects invalid output references %#", async (output) => {
    await expect(prepare(await fresh(), output)).rejects.toThrow()
  })
  it.each([null, false, "success", { kind: "other" }])("preserves ordinary result %#", async (output) => {
    const cas = await fresh()
    expect(await prepare(cas, output)).toEqual({ output, digests: [] })
    expect(
      await hydrate(cas, output, async () => {
        throw new Error("must not fetch")
      })
    ).toBe(true)
  })
  it("cleans a partial assembly after a verified chunk contradicts its index", async () => {
    const cas = await fresh()
    const bytes = Buffer.alloc(1), digest = hash(bytes)
    await writeBlob(cas, digest, bytes)
    const index = await storeIndex(cas, {
      kind: "smithers-build/chunks-v1",
      size: chunkBytes + 1,
      chunks: [{ digest, size: chunkBytes }, { digest, size: 1 }]
    })
    await expect(hydrate(cas, fileOutput("a".repeat(64), index), async () => false)).rejects.toThrow("chunk size")
    expect((await Fs.readdir(cas)).some((name) => name.includes(".tmp-"))).toBe(false)
  })
  it("cleans a complete assembly whose whole-file digest is wrong", async () => {
    const cas = await fresh()
    const bytes = Buffer.alloc(chunkBytes), digest = hash(bytes), last = hash(Buffer.alloc(1))
    await writeBlob(cas, digest, bytes)
    await writeBlob(cas, last, Buffer.alloc(1))
    const index = await storeIndex(cas, {
      kind: "smithers-build/chunks-v1",
      size: chunkBytes + 1,
      chunks: [{ digest, size: chunkBytes }, { digest: last, size: 1 }]
    })
    await expect(hydrate(cas, fileOutput("a".repeat(64), index), async () => false)).rejects.toThrow("assembled CAS")
    expect((await Fs.readdir(cas)).some((name) => name.includes(".tmp-"))).toBe(false)
  })
  it("skips following references after a missing index or whole blob", async () => {
    const cas = await fresh()
    let fetched = 0
    const output = fileOutput("a".repeat(64), "b".repeat(64))
    output.files.push(output.files[0]!)
    expect(
      await hydrate(cas, output, async () => {
        fetched++
        return false
      })
    ).toBe(false)
    expect(fetched).toBe(1)
    expect(await hydrate(cas, fileOutput("a".repeat(64)), async () => false)).toBe(false)
  })
})

it("round trips deterministic indexes and tree references without whole-file buffers", async () => {
  const source = await fresh(), destination = await fresh()
  const handle = await Fs.open(Path.join(source, "large"), "w")
  const hashing = createHash("sha256")
  try {
    for (const bytes of [Buffer.alloc(chunkBytes, 17), Buffer.alloc(3, 19)]) {
      hashing.update(bytes)
      await handle.writeFile(bytes)
    }
  } finally {
    await handle.close()
  }
  const digest = hashing.digest("hex")
  await Fs.rename(Path.join(source, "large"), Path.join(source, digest))
  const smallBytes = Buffer.from("tiny"), smallDigest = hash(smallBytes)
  await writeBlob(source, smallDigest, smallBytes)
  const output = {
    kind: "target-outputs",
    result: null,
    manifests: [{
      outDir: "dist",
      entries: [
        { kind: "file", path: "large", digest },
        { kind: "file", path: "same-bytes", digest },
        { kind: "link", path: "alias", target: "large", digest: "" },
        { kind: "file", path: "small", digest: smallDigest }
      ]
    }],
    files: []
  }
  const prepared = await prepare(source, output)
  expect(prepared.digests.length).toBe(4)
  expect(await prepare(source, prepared.output)).toEqual(prepared)
  await writeBlob(destination, smallDigest, smallBytes)
  const fetched: Array<string> = []
  expect(
    await hydrate(destination, prepared.output, async (part) => {
      fetched.push(part)
      await writeBlob(destination, part, await readBlob(source, part))
      return true
    })
  ).toBe(true)
  expect(new Set(fetched)).toEqual(new Set(prepared.digests.filter((digest) => digest !== smallDigest)))
  expect(await hasFile(destination, digest)).toBe(true)
  expect(await hasFile(destination, smallDigest)).toBe(true)
  expect(
    await hydrate(destination, prepared.output, async () => {
      throw new Error("local files must suffice")
    })
  ).toBe(true)
})

it("removes partial whole files after a later missing chunk", async () => {
  const cas = await fresh(), bytes = Buffer.alloc(chunkBytes), digest = hash(bytes)
  await writeBlob(cas, digest, bytes)
  const index = await storeIndex(cas, {
    kind: "smithers-build/chunks-v1",
    size: chunkBytes + 1,
    chunks: [
      { digest, size: chunkBytes },
      { digest: "b".repeat(64), size: 1 }
    ]
  })
  expect(await hydrate(cas, fileOutput("a".repeat(64), index), async () => false)).toBe(false)
  expect((await Fs.readdir(cas)).some((name) => name.includes(".tmp-"))).toBe(false)
  expect(await hasFile(cas, "a".repeat(64))).toBe(false)
})

it("bounds indexes at the read boundary and accepts legacy manifests without files", async () => {
  const cas = await fresh()
  expect(await prepare(cas, { kind: "build", manifests: [] })).toEqual({
    output: { kind: "build", manifests: [], files: [] },
    digests: []
  })
  const bytes = Buffer.alloc(64 * 1024 + 1), digest = hash(bytes)
  await writeBlob(cas, digest, bytes)
  await expect(readIndex(cas, digest)).rejects.toThrow("transfer bound")
})

it("refuses a large local file filed under another digest", async () => {
  const cas = await fresh(), digest = "a".repeat(64)
  const handle = await Fs.open(Path.join(cas, digest), "w")
  try {
    await handle.truncate(chunkBytes + 1)
  } finally {
    await handle.close()
  }
  await expect(prepare(cas, fileOutput(digest))).rejects.toThrow("changed during chunking")
})

it("fails closed while another real filesystem writer truncates and regrows artifacts", async () => {
  const { Worker } = await import("node:worker_threads")
  const { once } = await import("node:events")
  const cas = await fresh(), size = chunkBytes, digest = hash(Buffer.alloc(size))
  const path = Path.join(cas, digest)
  const handle = await Fs.open(path, "w")
  try {
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
  const control = new SharedArrayBuffer(4), state = new Int32Array(control)
  const worker = new Worker(
    `
    const { workerData, parentPort } = require("node:worker_threads");
    const fs = require("node:fs");
    const state = new Int32Array(workerData.control);
    const fd = fs.openSync(workerData.path, "r+");
    parentPort.postMessage("ready");
    while (Atomics.load(state, 0) === 0) {
      fs.ftruncateSync(fd, 0);
      fs.ftruncateSync(fd, workerData.size);
    }
    fs.closeSync(fd);
  `,
    { eval: true, workerData: { path, size, control } }
  )
  await once(worker, "message")
  const failures = new Set<string>()
  let truncated = false
  try {
    for (let attempt = 0; attempt < 512 && !truncated; attempt++) {
      try {
        expect(hash(await readBlob(cas, digest))).toBe(digest)
      } catch (cause) {
        expect(cause).toBeInstanceOf(Error)
        const message = (cause as Error).message
        expect(message).toMatch(/CAS artifact/)
        failures.add(message)
        truncated = message.includes("truncated")
      }
    }
  } finally {
    Atomics.store(state, 0, 1)
    await worker.terminate()
  }
  expect(failures.size).toBeGreaterThan(0)
  expect(truncated).toBe(true)
})

it("refuses a file truncated while its first chunk is published", async () => {
  const { watch } = await import("node:fs")
  const cas = await fresh(), size = chunkBytes + 1, digest = hash(Buffer.alloc(size))
  const path = Path.join(cas, digest)
  const handle = await Fs.open(path, "w")
  try {
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
  let truncated: Promise<void> | undefined
  const watcher = watch(cas, (_event, name) => {
    if (truncated === undefined && name?.includes(".tmp-")) truncated = Fs.truncate(path, 0)
  })
  try {
    await expect(prepare(cas, fileOutput(digest))).rejects.toThrow("truncated during chunking")
    await truncated
    expect((await Fs.stat(path)).size).toBe(0)
  } finally {
    watcher.close()
  }
})

it("refuses a file that grows after its initial size and bytes were captured", async () => {
  const { watch } = await import("node:fs")
  const cas = await fresh(), size = chunkBytes + 1, digest = hash(Buffer.alloc(size))
  const path = Path.join(cas, digest)
  const handle = await Fs.open(path, "w")
  try {
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
  let grown: Promise<void> | undefined
  const watcher = watch(cas, (_event, name) => {
    if (grown === undefined && name?.includes(".tmp-")) grown = Fs.appendFile(path, Buffer.alloc(1))
  })
  try {
    await expect(prepare(cas, fileOutput(digest))).rejects.toThrow("changed during chunking")
    await grown
    expect((await Fs.stat(path)).size).toBe(size + 1)
  } finally {
    watcher.close()
  }
})

it("refuses aggregate remote file amplification before downloading chunks or assembling files", async () => {
  const cas = await fresh()
  const indexes = new Map<string, Buffer>()
  const files = Array.from({ length: 5 }, (_, n) => {
    const digest = String(n + 1).repeat(64)
    const bytes = Buffer.from(JSON.stringify({
      kind: "smithers-build/chunks-v1",
      size: 4 * 1024 * 1024 * 1024,
      chunks: Array.from({ length: 256 }, () => ({ digest, size: chunkBytes }))
    }))
    const index = hash(bytes)
    indexes.set(index, bytes)
    return { digest, index, path: "file-" + n }
  })
  let chunks = 0
  await expect(hydrate(cas, { kind: "build", manifests: [], files }, async (digest) => {
    const bytes = indexes.get(digest)
    if (bytes === undefined) {
      chunks++
      return false
    }
    await writeBlob(cas, digest, bytes)
    return true
  })).rejects.toThrow("total byte limit")
  expect(chunks).toBe(0)
  expect((await Fs.readdir(cas)).sort()).toEqual([...indexes.keys()].sort())
})

it("keeps a complete legacy local result with more than 1000 artifacts usable", async () => {
  const cas = await fresh()
  const files: Array<{ digest: string; path: string }> = []
  for (let n = 0; n < 1001; n++) {
    const bytes = Buffer.from(String(n)), digest = hash(bytes)
    await writeBlob(cas, digest, bytes)
    files.push({ digest, path: String(n) })
  }
  expect(
    await hydrate(cas, { kind: "build", manifests: [], files }, async () => {
      throw new Error("complete local results must not fetch")
    })
  ).toBe(true)
  await expect(prepare(cas, { kind: "build", manifests: [], files })).rejects.toThrow("artifact reference limit")
})

it("counts unique whole-file bytes and direct references independently", () => {
  const budget = makeOutputBudget()
  const fourGiB = 4 * 1024 * 1024 * 1024
  for (let n = 0; n < 4; n++) {
    budget.file(String(n), fourGiB)
    budget.file(String(n), fourGiB)
  }
  expect(() => budget.file("another file", 1)).toThrow("total byte limit")
  for (let n = 0; n < 1000; n++) {
    budget.reference(String(n))
    budget.reference(String(n))
  }
  expect(budget.digests()).toHaveLength(1000)
  expect(() => budget.reference("another artifact")).toThrow("artifact reference limit")
})

it("transports the Go module-cache archive envelope through the same verified CAS", async () => {
  const a = await fresh(), b = await fresh(), bytes = Buffer.from("archive bytes"), digest = hash(bytes)
  await writeBlob(a, digest, bytes)
  const output = { kind: "directory-archive", outDir: ".gomodcache", digest }
  const prepared = await prepare(a, output)
  expect(prepared).toEqual({ output, digests: [digest] })
  expect(
    await hydrate(b, output, async (part) => {
      await writeBlob(b, part, await readBlob(a, part))
      return true
    })
  ).toBe(true)
  expect(await readBlob(b, digest)).toEqual(bytes)
})

it("refuses a descriptor whose inode was swapped after the path was inspected", async () => {
  const { Worker } = await import("node:worker_threads")
  const { once } = await import("node:events")
  const cas = await fresh(), bytes = Buffer.from("data"), digest = hash(bytes), path = Path.join(cas, digest)
  await writeBlob(cas, digest, bytes)
  await Fs.writeFile(path + ".replacement", bytes)
  const control = new SharedArrayBuffer(4), state = new Int32Array(control)
  const worker = new Worker(
    `
    const { workerData, parentPort } = require("node:worker_threads");
    const fs = require("node:fs"), state = new Int32Array(workerData.control), path = workerData.path;
    parentPort.postMessage("ready");
    while (Atomics.load(state, 0) === 0) {
      fs.renameSync(path, path + ".old");
      fs.renameSync(path + ".replacement", path);
      fs.renameSync(path + ".old", path + ".replacement");
    }
  `,
    { eval: true, workerData: { path, control } }
  )
  await once(worker, "message")
  let refused = false
  try {
    for (let attempt = 0; attempt < 512 && !refused; attempt++) {
      try {
        expect(await readBlob(cas, digest)).toEqual(bytes)
      } catch (cause) {
        expect(cause).toBeInstanceOf(Error)
        refused = (cause as Error).message.includes("changed while opening")
      }
    }
  } finally {
    Atomics.store(state, 0, 1)
    await worker.terminate()
  }
  expect(refused).toBe(true)
})

it("admits at most its capacity, halves on busy, and grows back one at a time", async () => {
  const limit = makeLimiter(8)
  let active = 0, peak = 0
  const unit = () =>
    limit(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    })
  await Promise.all(Array.from({ length: 40 }, unit))
  expect(peak).toBe(8)
  limit.busy()
  limit.busy()
  expect(limit.capacity()).toBe(2)
  peak = 0
  await Promise.all(Array.from({ length: 40 }, unit))
  expect(peak).toBe(2)
  limit.busy()
  limit.busy()
  expect(limit.capacity()).toBe(1)
  for (let n = 0; n < 7; n++) limit.admitted()
  expect(limit.capacity()).toBe(1)
  limit.admitted()
  expect(limit.capacity()).toBe(2)
  for (let n = 0; n < 16; n++) limit.admitted()
  expect(limit.capacity()).toBe(3)
  for (let n = 0; n < 1000; n++) limit.admitted()
  expect(limit.capacity()).toBe(8)
  const started = makeLimiter(8, 2)
  expect(started.capacity()).toBe(2)
  expect(() => makeLimiter(0)).toThrow("positive integer")
  expect(() => makeLimiter(2, 3)).toThrow("positive integer")
})

it("starts waiters in arrival order and releases a failed unit's permit", async () => {
  const limit = makeLimiter(1), order: Array<number> = []
  await Promise.all([
    limit(async () => {
      order.push(0)
      throw new Error("unit failed")
    }).catch(() => undefined),
    ...[1, 2, 3].map((n) => limit(async () => void order.push(n)))
  ])
  expect(order).toEqual([0, 1, 2, 3])
})

it("starts the lowest priority waiter first and keeps arrival order within a priority", async () => {
  const limit = makeLimiter(1), order: Array<string> = []
  let release!: () => void
  const held = limit(() => new Promise<void>((resolve) => release = resolve))
  const queued = [
    limit(async () => void order.push("late restore"), 2),
    limit(async () => void order.push("first restore a"), 1),
    limit(async () => void order.push("publication"), 0),
    limit(async () => void order.push("first restore b"), 1)
  ]
  release()
  await held
  await Promise.all(queued)
  expect(order).toEqual(["publication", "first restore a", "first restore b", "late restore"])
})

it("stops fetching after the first missing artifact of a concurrent restore", async () => {
  const cas = await fresh()
  const files = Array.from({ length: 32 }, (_, n) => ({ path: String(n), digest: hash(Buffer.from(String(n))) }))
  let fetched = 0
  expect(
    await hydrate(cas, { kind: "build", manifests: [], files }, async () => {
      fetched++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return false
    }, makeLimiter(4))
  ).toBe(false)
  // Only the units already admitted when the first miss lands fetch.
  expect(fetched).toBeLessThanOrEqual(4)
})
