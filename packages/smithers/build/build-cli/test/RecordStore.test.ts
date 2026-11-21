/**
 * Records of reads kept in the cache's content store: written one path per
 * line, sorted, compressed, named by the digest of their bytes, and read back
 * a line at a time. The cache entry that is looked up names each record by
 * its digest, its number of paths and its size, so it stays small however
 * many paths a run read. Real files in a temporary directory throughout.
 */
import { createHash } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import * as Zlib from "node:zlib"
import { afterEach, describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import * as RecordStore from "../src/internal/RecordStore.ts"

const made: Array<string> = []
afterEach(async () => {
  for (const directory of made.splice(0)) await Fs.rm(directory, { recursive: true, force: true })
})

const store = async (): Promise<string> => {
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-record-store-"))
  made.push(directory)
  return Path.join(directory, "cache", "cas")
}

const full: ObservedReads.Record = {
  reads: [["src/b.ts", "f:00"], ["node_modules/a.js", "-", "f:01"], ["src/a.ts", "f:02"]],
  lists: [["src", "00", ["a.ts"], [["made-by-a-step", 0]]], [".", "01", []]],
  from: [["//:install", "i1"]],
  given: [["node_modules/z.js", "f:03", 0], ["node_modules/y.js", "f:04", 0]],
  left: true,
  kept: { archive: "a".repeat(64), outside: [["/home/u/bin/tool", "f:00:x"]], gone: ["stale.txt"] },
  variables: [["COMMIT", "-"]],
  id: "1"
}
const plain: ObservedReads.Record = { reads: [["b", "-"], ["a", "f:00"]], lists: [], id: "2" }

/** The record as it comes back: each kind of path sorted. */
const sorted: ObservedReads.Record = {
  ...full,
  reads: [["node_modules/a.js", "-", "f:01"], ["src/a.ts", "f:02"], ["src/b.ts", "f:00"]],
  lists: [[".", "01", []], ["src", "00", ["a.ts"], [["made-by-a-step", 0]]]],
  given: [["node_modules/y.js", "f:04", 0], ["node_modules/z.js", "f:03", 0]]
}

const lines = (file: string): ReadonlyArray<string> =>
  Zlib.gunzipSync(NodeFs.readFileSync(file)).toString("utf8").trimEnd().split("\n")

describe("the records of reads in the content store", () => {
  it("names each record in the cache entry by digest, paths and size, and reads it back", async () => {
    const cas = await store()
    const entry = await RecordStore.save(cas, ObservedReads.store(full, [plain])!)
    expect(entry.kind).toBe("observed")
    expect(entry.format).toBe(ObservedReads.format)
    expect(entry.records.map((reference) => reference.paths)).toEqual([7, 2])
    for (const reference of entry.records) {
      expect(reference.digest).toMatch(/^[0-9a-f]{64}$/)
      expect((await Fs.stat(Path.join(cas, reference.digest))).size).toBe(reference.bytes)
    }
    expect(await RecordStore.load(cas, entry)).toEqual([sorted, { ...plain, reads: [["a", "f:00"], ["b", "-"]] }])
    // The same record is the same bytes: written again, it is the one already there.
    expect(await RecordStore.save(cas, ObservedReads.store(full, [])!)).toEqual({
      ...entry,
      records: [entry.records[0]]
    })
  })

  it("writes a record one path per line, sorted, after one line of what it says of the run", async () => {
    const cas = await store()
    const { records: [reference] } = await RecordStore.save(cas, ObservedReads.store(full, [])!)
    const written = lines(Path.join(cas, reference!.digest))
    expect(JSON.parse(written[0]!)).toEqual({
      format: ObservedReads.format,
      id: "1",
      reads: 3,
      lists: 2,
      given: 2,
      from: full.from,
      left: true,
      kept: full.kept,
      variables: full.variables
    })
    expect(written.slice(1).map((line) => JSON.parse(line))).toEqual([
      ...sorted.reads,
      ...sorted.lists,
      ...sorted.given!
    ])
  })

  // eliza's `turbo run build` read 168,803 paths: its record would be about 25 MiB in one JSON value, over what one
  // cache entry holds (16 MiB, 500,000 members). Here the entry is a few hundred bytes.
  it("keeps the entry of a record of 168,803 paths far under what one cache entry holds", async () => {
    const cas = await store()
    const large: ObservedReads.Record = {
      reads: Array.from({ length: 168_803 }, (_, index) => [
        `node_modules/.bun/package-${index % 4000}/node_modules/package-${index % 4000}/dist/file-${index}.js`,
        `f:${index.toString(16).padStart(64, "0")}`
      ]),
      lists: [],
      id: "large"
    }
    const entry = await RecordStore.save(cas, ObservedReads.store(large, [])!)
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(1024)
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(Cache.entryLimit)
    expect(entry.records[0]!.bytes).toBeLessThan(Cache.entryLimit)
    const [back] = await RecordStore.load(cas, entry)
    expect(back?.reads.length).toBe(168_803)
    expect(back?.id).toBe("large")
  })

  it("leaves out a record whose bytes, size, lines or count are not what the entry names", async () => {
    const cas = await store()
    const entry = await RecordStore.save(cas, ObservedReads.store(full, [])!)
    const [reference] = entry.records
    const file = Path.join(cas, reference!.digest)
    const original = await Fs.readFile(file)
    /** The entry, with the record's bytes replaced. */
    const withBytes = async (bytes: Buffer): Promise<ReadonlyArray<ObservedReads.Record>> => {
      await Fs.writeFile(file, bytes)
      return RecordStore.load(cas, entry)
    }
    const gzipped = (text: string): Buffer => Zlib.gzipSync(Buffer.from(text))
    const head = lines(file)[0]!
    const body = lines(file).slice(1).join("\n")
    // One byte changed: the digest is not the entry's.
    const changed = Buffer.from(original)
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1
    expect(await withBytes(changed)).toEqual([])
    // Bytes that are not gzip, lines that are not JSON, a line more than the head counts, another format, no id.
    for (
      const bytes of [
        Buffer.from("plain text, not gzip".padEnd(original.length, ".")),
        gzipped(`${head}\nnot json\n`),
        gzipped(`${head}\n${body}\n["extra", "-"]\n`),
        gzipped(`${head.replace(ObservedReads.format, "smthrs-observed-reads/2")}\n${body}\n`),
        gzipped(`${head.replace(/"id":"1",/, "")}\n${body}\n`),
        gzipped(`${head.replace(/"reads":3/, "\"reads\":4")}\n${body}\n`),
        gzipped(`${head}\n${body.replace("\"f:02\"", "2")}\n`),
        gzipped("")
      ]
    ) {
      // Each is checked by its own digest and size, so only the lines can be wrong.
      const named = {
        digest: createHash("sha256").update(bytes).digest("hex"),
        paths: reference!.paths,
        bytes: bytes.length
      }
      await Fs.writeFile(Path.join(cas, named.digest), bytes)
      expect(await RecordStore.load(cas, { ...entry, records: [named] })).toEqual([])
    }
    await Fs.writeFile(file, original)
    // Another size, another count of paths, or no file at all.
    expect(await RecordStore.load(cas, { ...entry, records: [{ ...reference!, bytes: reference!.bytes + 1 }] }))
      .toEqual([])
    expect(await RecordStore.load(cas, { ...entry, records: [{ ...reference!, paths: 6 }] })).toEqual([])
    await Fs.rm(file)
    expect(await RecordStore.load(cas, entry)).toEqual([])
  })

  it("names no record from an entry of another shape, or of the form before this one", async () => {
    const cas = await store()
    const reference = { digest: "a".repeat(64), paths: 1, bytes: 10 }
    const entry = { kind: "observed", format: ObservedReads.format, records: [reference] }
    expect(RecordStore.references(entry)).toEqual([reference])
    for (
      const other of [
        undefined,
        null,
        "text",
        { ...entry, kind: "shell-test" },
        { ...entry, format: "smthrs-observed-reads/2", records: [plain] },
        { ...entry, records: "none" },
        { ...entry, records: [null] },
        { ...entry, records: [{ ...reference, digest: "../x" }] },
        { ...entry, records: [{ ...reference, digest: 1 }] },
        { ...entry, records: [{ ...reference, paths: -1 }] },
        { ...entry, records: [{ ...reference, paths: 0.5 }] },
        { ...entry, records: [{ ...reference, paths: ObservedReads.maximumPaths + 1 }] },
        { ...entry, records: [{ ...reference, bytes: 0 }] },
        { ...entry, records: [{ ...reference, bytes: "10" }] }
      ]
    ) {
      expect(RecordStore.references(other)).toEqual([])
      expect(await RecordStore.load(cas, other)).toEqual([])
    }
  })

  it("says which records an entry names that could not be read, and why", async () => {
    const cas = await store()
    const entry = await RecordStore.save(cas, ObservedReads.store(full, [plain])!)
    expect(await RecordStore.loadAll(cas, entry)).toEqual({
      records: [sorted, { ...plain, reads: [["a", "f:00"], ["b", "-"]] }],
      unread: []
    })
    expect(RecordStore.unreadReason([])).toBeUndefined()
    // A cache carried without its content store: the entry is there and its records are not.
    const [first, second] = entry.records
    await Fs.rm(Path.join(cas, first!.digest))
    expect((await RecordStore.loadAll(cas, entry)).unread).toEqual(["missing"])
    expect(RecordStore.unreadReason(["missing"])).toBe(
      "its record of what it read is not in the cache's content store, the cas directory beside the cache's entries"
    )
    // Bytes that are not the ones stored.
    await Fs.writeFile(Path.join(cas, second!.digest), "other bytes")
    expect((await RecordStore.loadAll(cas, entry)).unread).toEqual(["missing", "changed"])
    expect(RecordStore.unreadReason(["changed"])).toBe(
      "its record of what it read is not as it was stored in the cache's content store"
    )
  })

  it("is the cache directory's content store", () => {
    expect(RecordStore.contentStore("/w", ".smithers/cache")).toBe(Path.join("/w", ".smithers", "cache", "cas"))
  })
})
