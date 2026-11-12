/**
 * Bounded file representations for the CLI's remote content store.
 *
 * Local manifests keep their whole-file digest. Large remote files add the
 * digest of a deterministic index; chunks and the index are ordinary CAS
 * artifacts. Only complete, verified files enter the local store.
 *
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import { createHash, randomUUID } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { optionalOpenFlag } from "./Fs.ts"

/** The protocol's per-artifact ceiling, also the fixed chunk size.
 * @category artifacts
 * @since 1.0.0
 */
export const chunkBytes = 16 * 1024 * 1024
/** A captured file is bounded to four GiB, matching output-tree capture. */
const fileLimit = 4 * 1024 * 1024 * 1024
const indexLimit = 64 * 1024
// Bound work induced by one untrusted entry, not only by one HTTP body.
// Complete legacy local results do not need this remote-transfer budget.
const totalLimit = 16 * 1024 * 1024 * 1024
const referenceLimit = 1000
const hex = /^[a-f0-9]{64}$/
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/**
 * Local admission refusal for an entry above remote output transfer limits.
 * It skips that entry without disabling the remote service.
 *
 * @category errors
 * @since 1.0.0
 */
export class OutputLimitError extends Error {}

/** A CAS artifact, chunk index, or output entry that failed verification; it is never restored. */
class CasArtifactInvalid extends Data.TaggedError("smithers-build/CasArtifactInvalid")<{ readonly message: string }> {}

/**
 * Accounts unique files and direct artifact references in one remote entry.
 * Complete legacy local hits bypass remote admission entirely.
 *
 * @category artifacts
 * @since 1.0.0
 */
export const makeOutputBudget = () => {
  const files = new Set<string>()
  const references = new Set<string>()
  let total = 0
  return {
    file(digest: string, size: number): void {
      if (files.has(digest)) return
      files.add(digest)
      total += size
      if (total > totalLimit) throw new OutputLimitError("remote output entry exceeds its total byte limit")
    },
    reference(digest: string): void {
      references.add(digest)
      if (references.size > referenceLimit) {
        throw new OutputLimitError("remote output entry exceeds its artifact reference limit")
      }
    },
    digests: () => [...references].sort()
  }
}

interface FileReference {
  readonly digest: string
  readonly index?: string
}
interface ChunkIndex {
  readonly kind: "smithers-build/chunks-v1"
  readonly size: number
  readonly chunks: ReadonlyArray<{ readonly digest: string; readonly size: number }>
}

/**
 * Opens only a regular, non-symlink CAS artifact, including after an open race.
 *
 * A concurrent writer of the same digest publishes by renaming its verified
 * copy onto the path, which changes the inode between the `lstat` and the
 * open. That is a race, not a refusal: every writer of one digest writes the
 * same verified bytes, so the open is retried. Every caller verifies the
 * bytes it reads against the digest, so a retry cannot widen what is accepted.
 */
const openBlob = async (cas: string, digest: string, maximumBytes = fileLimit) => {
  if (!hex.test(digest)) throw new CasArtifactInvalid({ message: "invalid CAS digest" })
  const path = Path.join(cas, digest)
  for (let attempt = 1;; attempt += 1) {
    const before = await Fs.lstat(path)
    if (!before.isFile()) throw new CasArtifactInvalid({ message: "CAS artifact is not a regular file" })
    const handle = await Fs.open(
      path,
      NodeFs.constants.O_RDONLY | optionalOpenFlag("O_NOFOLLOW") | optionalOpenFlag("O_NONBLOCK")
    )
    try {
      const after = await handle.stat()
      if (!after.isFile() || before.ino !== after.ino || before.dev !== after.dev) {
        throw new CasArtifactInvalid({ message: "CAS artifact changed while opening" })
      }
      if (after.size > maximumBytes) throw new OutputLimitError("CAS artifact exceeds its file bound")
      return handle
    } catch (cause) {
      await handle.close()
      if (attempt < 3 && cause instanceof Error && cause.message === "CAS artifact changed while opening") continue
      throw cause
    }
  }
}

/** Reads and verifies a single bounded artifact; never buffers a large file.
 * @category artifacts
 * @since 1.0.0
 */
export const readBlob = async (cas: string, digest: string, limit = chunkBytes): Promise<Buffer> => {
  const handle = await openBlob(cas, digest)
  try {
    const size = (await handle.stat()).size
    if (size > limit) throw new CasArtifactInvalid({ message: "CAS artifact exceeds its transfer bound" })
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const read = await handle.read(bytes, offset, size - offset, offset)
      if (read.bytesRead === 0) throw new CasArtifactInvalid({ message: "CAS artifact was truncated" })
      offset += read.bytesRead
    }
    if ((await handle.stat()).size !== size || hash(bytes) !== digest) {
      throw new CasArtifactInvalid({ message: "CAS artifact failed verification" })
    }
    return bytes
  } finally {
    await handle.close()
  }
}

/** Verifies a local whole-file digest without buffering its contents.
 * @category artifacts
 * @since 1.0.0
 */
export const hasFile = async (cas: string, digest: string): Promise<boolean> => {
  try {
    const handle = await openBlob(cas, digest, Number.MAX_SAFE_INTEGER)
    try {
      const hashing = createHash("sha256")
      for await (const bytes of handle.createReadStream({ autoClose: false })) hashing.update(bytes)
      return hashing.digest("hex") === digest
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

/** Publishes verified bytes atomically under their content identity.
 * @category artifacts
 * @since 1.0.0
 */
export const writeBlob = async (
  cas: string,
  digest: string,
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<void> => {
  if (!hex.test(digest) || bytes.byteLength > chunkBytes || hash(bytes) !== digest) {
    throw new CasArtifactInvalid({ message: "CAS artifact failed verification" })
  }
  await Fs.mkdir(cas, { recursive: true })
  const temporary = Path.join(cas, digest + ".tmp-" + randomUUID())
  try {
    const handle = await Fs.open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    signal?.throwIfAborted()
    await Fs.rename(temporary, Path.join(cas, digest))
  } finally {
    await Fs.rm(temporary, { force: true })
  }
}

const decodeIndex = (bytes: Uint8Array): ChunkIndex => {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as ChunkIndex
  if (
    value === null || value.kind !== "smithers-build/chunks-v1" || !Number.isSafeInteger(value.size) ||
    value.size <= chunkBytes || value.size > fileLimit || !Array.isArray(value.chunks) ||
    value.chunks.length !== Math.ceil(value.size / chunkBytes)
  ) throw new CasArtifactInvalid({ message: "invalid CAS chunk index" })
  for (let i = 0; i < value.chunks.length; i++) {
    const chunk = value.chunks[i]
    if (
      chunk === undefined || chunk === null || typeof chunk !== "object" || typeof chunk.digest !== "string" ||
      !hex.test(chunk.digest) ||
      chunk.size !== Math.min(chunkBytes, value.size - i * chunkBytes)
    ) throw new CasArtifactInvalid({ message: "invalid CAS chunk" })
  }
  return value
}

/** Returns the bounded, verified chunk list of a file's index.
 * @category artifacts
 * @since 1.0.0
 */
export const readIndex = async (cas: string, digest: string): Promise<ChunkIndex> =>
  decodeIndex(await readBlob(cas, digest, indexLimit))

/** Creates deterministic chunks from the already-captured local whole file. */
const splitFile = async (cas: string, digest: string): Promise<string | undefined> => {
  const handle = await openBlob(cas, digest)
  try {
    const size = (await handle.stat()).size
    if (size <= chunkBytes) return undefined
    const chunks: Array<{ digest: string; size: number }> = []
    const whole = createHash("sha256")
    for (let offset = 0; offset < size; offset += chunkBytes) {
      const bytes = Buffer.alloc(Math.min(chunkBytes, size - offset))
      let read = 0
      while (read < bytes.length) {
        const part = await handle.read(bytes, read, bytes.length - read, offset + read)
        if (part.bytesRead === 0) throw new CasArtifactInvalid({ message: "CAS file was truncated during chunking" })
        read += part.bytesRead
      }
      whole.update(bytes)
      const partDigest = hash(bytes)
      await writeBlob(cas, partDigest, bytes)
      chunks.push({ digest: partDigest, size: bytes.length })
    }
    if (whole.digest("hex") !== digest || (await handle.stat()).size !== size) {
      throw new CasArtifactInvalid({ message: "CAS file changed during chunking" })
    }
    const bytes = Buffer.from(JSON.stringify({ kind: "smithers-build/chunks-v1", size, chunks }))
    const index = hash(bytes)
    await writeBlob(cas, index, bytes)
    return index
  } finally {
    await handle.close()
  }
}

/**
 * Visits the CLI file/tree manifests and Go module archive envelope.
 * Paths never drive I/O here: the runner binds those before materialization.
 */
const mapFiles = async (output: unknown, visit: (file: FileReference) => Promise<FileReference>): Promise<unknown> => {
  if (typeof output !== "object" || output === null) return output
  const value = output as Record<string, unknown>
  const file = async (candidate: unknown) => {
    if (typeof candidate !== "object" || candidate === null) {
      throw new CasArtifactInvalid({ message: "invalid output file" })
    }
    const entry = candidate as Record<string, unknown>
    if (
      typeof entry["digest"] !== "string" || !hex.test(entry["digest"]) ||
      (entry["index"] !== undefined && (typeof entry["index"] !== "string" || !hex.test(entry["index"])))
    ) {
      throw new CasArtifactInvalid({ message: "invalid output content identity" })
    }
    return { ...entry, ...await visit(entry as unknown as FileReference) }
  }
  if (value["kind"] === "directory-archive") return file(value)
  if (value["kind"] !== "build" && value["kind"] !== "target-outputs") return output
  if (!Array.isArray(value["manifests"]) || (value["files"] !== undefined && !Array.isArray(value["files"]))) {
    throw new CasArtifactInvalid({ message: "invalid output manifests" })
  }
  const manifests: Array<unknown> = []
  for (const candidate of value["manifests"]) {
    if (typeof candidate !== "object" || candidate === null || !Array.isArray(candidate.entries)) {
      throw new CasArtifactInvalid({ message: "invalid output manifest" })
    }
    const entries: Array<unknown> = []
    for (const entry of candidate.entries) entries.push(entry.kind === "file" ? await file(entry) : entry)
    manifests.push({ ...candidate, entries })
  }
  const files: Array<unknown> = []
  for (const entry of (value["files"] ?? []) as Array<unknown>) files.push(await file(entry))
  return { ...value, manifests, files }
}

/** Prepares remote file representations and all direct retention references.
 * @category artifacts
 * @since 1.0.0
 */
export const prepare = async (cas: string, output: unknown): Promise<{ output: unknown; digests: Array<string> }> => {
  const budget = makeOutputBudget()
  const indexes = new Map<string, string | undefined>()
  const prepared = await mapFiles(output, async (file) => {
    if (!indexes.has(file.digest)) {
      const handle = await openBlob(cas, file.digest)
      try {
        budget.file(file.digest, (await handle.stat()).size)
      } finally {
        await handle.close()
      }
      const index = file.index ?? await splitFile(cas, file.digest)
      indexes.set(file.digest, index)
      if (index === undefined) budget.reference(file.digest)
      else {
        budget.reference(index)
        for (const chunk of (await readIndex(cas, index)).chunks) budget.reference(chunk.digest)
      }
    }
    const index = indexes.get(file.digest)
    return index === undefined ? file : { ...file, index }
  })
  return { output: prepared, digests: budget.digests() }
}

/**
 * Runs one unit of artifact work inside a shared concurrency bound.
 *
 * @category models
 * @since 1.0.0
 */
export type Limiter = <A>(run: () => Promise<A>, priority?: number) => Promise<A>

/**
 * A {@link Limiter} whose admission follows the service's answers.
 *
 * @category models
 * @since 1.0.0
 */
export interface AdaptiveLimiter extends Limiter {
  /** Halves admission, never below one: the service refused work as busy. */
  readonly busy: () => void
  /** Records one admitted exchange; enough in a row admit one more. */
  readonly admitted: () => void
  /** How many units may run at once now. */
  readonly capacity: () => number
}

/**
 * Creates a counting semaphore that admits up to `maximum` units of work.
 *
 * Admission starts at `initial` (default `maximum`), halves on
 * {@link AdaptiveLimiter.busy}, and grows by one after eight times the current
 * capacity of consecutive {@link AdaptiveLimiter.admitted} calls, so it
 * settles at what the service admits and rarely probes past it.
 * Waiters start lowest `priority` first (default zero), and in arrival order
 * within one priority. A unit's failure releases its permit.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeLimiter = (maximum: number, initial = maximum): AdaptiveLimiter => {
  if (
    !Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(initial) || initial < 1 ||
    initial > maximum
  ) throw new TypeError("limiter permits must be a positive integer")
  let capacity = initial
  let active = 0
  let streak = 0
  // Sorted by priority, then arrival; a new waiter goes after its equals.
  const waiting: Array<{ readonly priority: number; readonly start: () => void }> = []
  const wake = (): void => {
    while (active < capacity && waiting.length > 0) {
      active += 1
      waiting.shift()!.start()
    }
  }
  const limiter = async <A>(run: () => Promise<A>, priority = 0): Promise<A> => {
    if (active < capacity && waiting.length === 0) active += 1
    else {
      await new Promise<void>((start) => {
        let index = waiting.length
        while (index > 0 && waiting[index - 1]!.priority > priority) index -= 1
        waiting.splice(index, 0, { priority, start })
      })
    }
    try {
      return await run()
    } finally {
      active -= 1
      wake()
    }
  }
  return Object.assign(limiter, {
    busy: (): void => {
      capacity = Math.max(1, Math.ceil(capacity / 2))
      streak = 0
    },
    admitted: (): void => {
      streak += 1
      if (capacity < maximum && streak >= capacity * 8) {
        capacity += 1
        streak = 0
        wake()
      }
    },
    capacity: () => capacity
  })
}

/**
 * Visits every item inside `limit` and reports whether every visit succeeded.
 *
 * The first `false` or failure stops visits that have not started yet. Every
 * started visit settles before this returns, so no write outlives the call.
 * The first failure is rethrown after that.
 */
const visitAll = async <T>(
  items: Iterable<T>,
  limit: Limiter,
  visit: (item: T) => Promise<boolean>
): Promise<boolean> => {
  let ok = true
  let failure: { readonly cause: unknown } | undefined
  await Promise.all([...items].map((item) =>
    limit(async () => {
      if (!ok || failure !== undefined) return
      try {
        if (!await visit(item)) ok = false
      } catch (cause) {
        failure ??= { cause }
      }
    })
  ))
  if (failure !== undefined) throw failure.cause
  return ok
}

/**
 * Fetches missing artifacts and assembles large files in a sibling temporary
 * file. A missing/corrupt chunk never publishes a partial whole file.
 *
 * `limit` bounds every fetch, local verification, and assembly. Share one
 * limiter across concurrent hydrations to bound the whole process: each unit
 * holds at most one 16 MiB artifact in memory. The default runs one unit at a
 * time. The first missing artifact stops the work that has not started.
 *
 * @category artifacts
 * @since 1.0.0
 */
export const hydrate = async (
  cas: string,
  output: unknown,
  fetchBlob: (digest: string) => Promise<boolean>,
  limit: Limiter = makeLimiter(1)
): Promise<boolean> => {
  const files = new Map<string, FileReference>()
  await mapFiles(output, async (file) => {
    files.set(file.digest, file)
    return file
  })
  const complete = new Set<string>()
  await visitAll(files.values(), limit, async (file) => {
    if (await hasFile(cas, file.digest)) complete.add(file.digest)
    return true
  })
  if (complete.size === files.size) return true

  // Account every direct reference before the first fetch, then every unique
  // whole file and chunk reference before a chunk is fetched or a large
  // assembly begins. Reused chunks cannot amplify disk writes beyond the same
  // aggregate bound capture applies to an output tree.
  const budget = makeOutputBudget()
  const missing = [...files.values()].filter((file) => !complete.has(file.digest))
  for (const file of missing) budget.reference(file.index ?? file.digest)
  const fetchedDirect = await visitAll(missing, limit, async (file) => {
    if (file.index === undefined) return fetchBlob(file.digest)
    return await hasFile(cas, file.index) || fetchBlob(file.index)
  })
  if (!fetchedDirect) return false

  const indexes = new Map<string, ChunkIndex>()
  for (const file of files.values()) {
    if (complete.has(file.digest) || file.index === undefined) {
      // A fetched blob was verified against its digest before it was written.
      budget.file(file.digest, (await Fs.lstat(Path.join(cas, file.digest))).size)
    } else {
      const index = await readIndex(cas, file.index)
      indexes.set(file.digest, index)
      budget.file(file.digest, index.size)
      for (const chunk of index.chunks) budget.reference(chunk.digest)
    }
  }

  const chunks = new Set<string>()
  for (const index of indexes.values()) for (const chunk of index.chunks) chunks.add(chunk.digest)
  const fetchedChunks = await visitAll(chunks, limit, async (digest) => await hasFile(cas, digest) || fetchBlob(digest))
  if (!fetchedChunks) return false

  return visitAll(indexes, limit, async ([digest, index]) => {
    const temporary = Path.join(cas, digest + ".tmp-" + randomUUID())
    try {
      const handle = await Fs.open(temporary, "wx", 0o600)
      try {
        const whole = createHash("sha256")
        for (const chunk of index.chunks) {
          // readBlob verifies the chunk's SHA-256 again; a chunk replaced on
          // disk since it was fetched fails here.
          const bytes = await readBlob(cas, chunk.digest)
          if (bytes.length !== chunk.size) {
            throw new CasArtifactInvalid({ message: "CAS chunk size differs from index" })
          }
          whole.update(bytes)
          await handle.writeFile(bytes)
        }
        if (whole.digest("hex") !== digest) {
          throw new CasArtifactInvalid({ message: "assembled CAS file failed verification" })
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
      await Fs.rename(temporary, Path.join(cas, digest))
    } finally {
      await Fs.rm(temporary, { force: true })
    }
    return true
  })
}
