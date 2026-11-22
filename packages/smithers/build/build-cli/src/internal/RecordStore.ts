/**
 * Where a declaration's records of reads are kept: each record in the cache's
 * content store, by the digest of its bytes, and the cache entry that is
 * looked up holds only each record's digest, its number of paths and its size.
 *
 * A record is written one line per path, sorted, after one line that holds
 * what the record says of the run as a whole, and compressed with gzip. It is
 * read back one line at a time from the compressed stream: the whole record
 * is never parsed as one value. A record whose bytes do not have its digest,
 * or whose lines are not the paths the entry counts, is no record: the step
 * runs again.
 *
 * @since 1.0.0
 */

import { createHash, randomBytes } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Readline from "node:readline"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import * as Zlib from "node:zlib"
import * as ObservedReads from "./ObservedReads.ts"
import { byCodeUnit } from "./Text.ts"

/**
 * One record in the content store, as the cache entry names it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Reference {
  /** The SHA-256 of the compressed bytes, which is the record's name in the content store. */
  readonly digest: string
  /** The paths the record holds: reads, listed directories and files steps before it gave. */
  readonly paths: number
  /** The size of the compressed bytes. */
  readonly bytes: number
}

/**
 * The cache entry of a declaration's records.
 *
 * @category models
 * @since 1.0.0
 */
export interface Entry {
  readonly kind: "observed"
  readonly format: string
  readonly records: ReadonlyArray<Reference>
}

/**
 * The content store of a cache directory, where records are kept.
 *
 * @category paths
 * @since 1.0.0
 */
export const contentStore = (root: string, cacheDirectory: string): string =>
  NodePath.join(root, ...cacheDirectory.split("/"), "cas")

const hex = /^[0-9a-f]{64}$/

/** What a record says of its run as a whole: everything but its paths, and how many of each kind it holds. */
interface Head {
  readonly format: string
  readonly id: string
  readonly reads: number
  readonly lists: number
  readonly given?: number
  readonly from?: ObservedReads.Record["from"]
  readonly left?: true
  readonly made?: ObservedReads.Record["made"]
  readonly kept?: ObservedReads.Record["kept"]
  readonly variables?: ObservedReads.Record["variables"]
  readonly running?: ObservedReads.Record["running"]
  readonly served?: ObservedReads.Record["served"]
}

const sorted = <A extends ReadonlyArray<unknown>>(rows: ReadonlyArray<A>): ReadonlyArray<A> =>
  [...rows].sort((a, b) => byCodeUnit(a[0] as string, b[0] as string))

/** The lines of a record: its head, then its reads, listed directories and given files, each sorted by path. */
function* linesOf(record: ObservedReads.Record): Generator<string> {
  const given = record.given ?? []
  const head: Head = {
    format: ObservedReads.format,
    id: record.id!,
    reads: record.reads.length,
    lists: record.lists.length,
    ...(record.given === undefined ? {} : { given: given.length }),
    ...(record.from === undefined ? {} : { from: record.from }),
    ...(record.left === undefined ? {} : { left: record.left }),
    ...(record.made === undefined ? {} : { made: record.made }),
    ...(record.kept === undefined ? {} : { kept: record.kept }),
    ...(record.variables === undefined ? {} : { variables: record.variables }),
    ...(record.running === undefined ? {} : { running: record.running }),
    ...(record.served === undefined ? {} : { served: record.served })
  }
  yield `${JSON.stringify(head)}\n`
  for (const row of sorted(record.reads)) yield `${JSON.stringify(row)}\n`
  for (const row of sorted(record.lists)) yield `${JSON.stringify(row)}\n`
  for (const row of sorted(given)) yield `${JSON.stringify(row)}\n`
}

/** A pass-through that hashes and counts what goes through it. */
const tap = (hash: ReturnType<typeof createHash>, count: { bytes: number }): Transform =>
  new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk)
      count.bytes += chunk.length
      done(null, chunk)
    }
  })

/**
 * Writes one record into the content store, compressed, and answers how the
 * cache entry names it. A record already there is not written again.
 *
 * @category storing
 * @since 1.0.0
 */
export const write = async (cas: string, record: ObservedReads.Record): Promise<Reference> => {
  await Fs.mkdir(cas, { recursive: true })
  const temporary = NodePath.join(cas, `.record-${process.pid}-${randomBytes(8).toString("hex")}`)
  const hash = createHash("sha256")
  const count = { bytes: 0 }
  try {
    await pipeline(
      Readable.from(linesOf(record)),
      Zlib.createGzip(),
      tap(hash, count),
      NodeFs.createWriteStream(temporary, { flags: "wx" })
    )
    const digest = hash.digest("hex")
    await Fs.rename(temporary, NodePath.join(cas, digest))
    return { digest, paths: ObservedReads.pathsOf(record), bytes: count.bytes }
  } finally {
    await Fs.rm(temporary, { force: true })
  }
}

/**
 * Writes each record of a declaration into the content store and answers the
 * cache entry that names them.
 *
 * @category storing
 * @since 1.0.0
 */
export const save = async (cas: string, stored: ObservedReads.Stored): Promise<Entry> => {
  const records: Array<Reference> = []
  for (const record of stored.records) records.push(await write(cas, record))
  return { kind: "observed", format: ObservedReads.format, records }
}

/**
 * The references of a cache entry; any other shape, or another format, names none.
 *
 * @category loading
 * @since 1.0.0
 */
export const references = (output: unknown): ReadonlyArray<Reference> => {
  if (typeof output !== "object" || output === null) return []
  const value = output as { readonly kind?: unknown; readonly format?: unknown; readonly records?: unknown }
  if (value.kind !== "observed" || value.format !== ObservedReads.format || !Array.isArray(value.records)) return []
  const valid = value.records.every((reference: unknown) => {
    if (typeof reference !== "object" || reference === null) return false
    const { bytes, digest, paths } = reference as { readonly [key in keyof Reference]?: unknown }
    return typeof digest === "string" && hex.test(digest) && Number.isSafeInteger(paths) && (paths as number) >= 0 &&
      (paths as number) <= ObservedReads.maximumPaths && Number.isSafeInteger(bytes) && (bytes as number) > 0
  })
  return valid ? value.records as ReadonlyArray<Reference> : []
}

/**
 * Reads one record from the content store, a line at a time. `undefined`
 * when it is not there, its bytes do not have its digest or its size, or its
 * lines are not a record of the paths the entry counts.
 *
 * @category loading
 * @since 1.0.0
 */
export const read = async (cas: string, reference: Reference): Promise<ObservedReads.Record | undefined> => {
  const file = NodePath.join(cas, reference.digest)
  const stats = await Fs.stat(file).catch(() => undefined)
  if (stats === undefined || !stats.isFile() || stats.size !== reference.bytes) return undefined
  const hash = createHash("sha256")
  const count = { bytes: 0 }
  const input = NodeFs.createReadStream(file)
  const unpacked = input.pipe(tap(hash, count)).pipe(Zlib.createGunzip())
  const lines = Readline.createInterface({ input: unpacked, crlfDelay: Infinity })
  let head: Head | undefined
  const reads: Array<readonly [string, string] | readonly [string, string, string]> = []
  const lists: Array<ObservedReads.Record["lists"][number]> = []
  const given: Array<NonNullable<ObservedReads.Record["given"]>[number]> = []
  try {
    for await (const line of lines) {
      const value: unknown = JSON.parse(line)
      if (head === undefined) {
        head = value as Head
        continue
      }
      if (reads.length < head.reads) reads.push(value as (typeof reads)[number])
      else if (lists.length < head.lists) lists.push(value as (typeof lists)[number])
      else if (given.length < (head.given ?? 0)) given.push(value as (typeof given)[number])
      else return undefined
    }
  } catch {
    return undefined
  } finally {
    lines.close()
    input.destroy()
  }
  if (head === undefined || hash.digest("hex") !== reference.digest || count.bytes !== reference.bytes) return undefined
  if (head.format !== ObservedReads.format || typeof head.id !== "string") return undefined
  if (reads.length !== head.reads || lists.length !== head.lists || given.length !== (head.given ?? 0)) return undefined
  const record = ObservedReads.asRecord({
    reads,
    lists,
    ...(head.from === undefined ? {} : { from: head.from }),
    ...(head.given === undefined ? {} : { given }),
    ...(head.left === undefined ? {} : { left: head.left }),
    ...(head.made === undefined ? {} : { made: head.made }),
    ...(head.kept === undefined ? {} : { kept: head.kept }),
    ...(head.variables === undefined ? {} : { variables: head.variables }),
    ...(head.running === undefined ? {} : { running: head.running }),
    ...(head.served === undefined ? {} : { served: head.served }),
    id: head.id
  })
  return record !== undefined && ObservedReads.pathsOf(record) === reference.paths ? record : undefined
}

/**
 * The records a cache entry names, read from the content store, and why any
 * other it names could not be: `missing` when the content store does not
 * hold it, as where a cache was carried without its content store;
 * `changed` when its bytes are not the ones stored.
 *
 * @category loading
 * @since 1.0.0
 */
export const loadAll = async (
  cas: string,
  output: unknown
): Promise<{
  readonly records: ReadonlyArray<ObservedReads.Record>
  readonly unread: ReadonlyArray<"missing" | "changed">
}> => {
  const records: Array<ObservedReads.Record> = []
  const unread: Array<"missing" | "changed"> = []
  for (const reference of references(output)) {
    const record = await read(cas, reference)
    if (record !== undefined) records.push(record)
    else unread.push(NodeFs.existsSync(NodePath.join(cas, reference.digest)) ? "changed" : "missing")
  }
  return { records, unread }
}

/**
 * The records a cache entry names, each read from the content store. A
 * record that cannot be read is left out, as an entry of another form is.
 *
 * @category loading
 * @since 1.0.0
 */
export const load = async (cas: string, output: unknown): Promise<ReadonlyArray<ObservedReads.Record>> =>
  (await loadAll(cas, output)).records

/**
 * Why a step whose cache entry names records runs when none of them could be
 * read, or `undefined` when nothing was left unread.
 *
 * @category loading
 * @since 1.0.0
 */
export const unreadReason = (unread: ReadonlyArray<"missing" | "changed">): string | undefined =>
  unread.length === 0
    ? undefined
    : unread.includes("missing")
    ? "its record of what it read is not in the cache's content store, the cas directory beside the cache's entries"
    : "its record of what it read is not as it was stored in the cache's content store"
