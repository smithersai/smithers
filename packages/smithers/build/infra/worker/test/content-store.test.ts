import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeContentStore } from "../R2ContentStore.ts"

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex")
const digestBytes = (digest: string): ArrayBuffer =>
  Uint8Array.from(digest.match(/.{2}/g)!, (pair) => Number.parseInt(pair, 16)).buffer

const object = (
  key: string,
  options: { readonly checksum?: ArrayBuffer; readonly body?: ReadableStream; readonly size?: number }
): R2ObjectBody =>
  ({
    body: options.body ?? new Response("artifact").body!,
    checksums: options.checksum === undefined ? {} : { sha256: options.checksum },
    key,
    size: options.size ?? 8
  }) as unknown as R2ObjectBody

const sha256 = (bytes: Uint8Array): ArrayBuffer =>
  Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer

/** Bytes no accidental empty or text payload could stand in for. */
const artifactBytes = Uint8Array.from([0, 255, 13, 10, 0, 34, 92, 128, 7, 200, 255, 1])
const artifactDigest = createHash("sha256").update(artifactBytes).digest("hex")

interface PutCall {
  readonly key: string
  readonly bytes: Uint8Array
  readonly options: R2PutOptions | undefined
}

interface StoredObject {
  readonly bytes: Uint8Array
  readonly checksum: ArrayBuffer | undefined
}

/**
 * A bucket that keeps the bytes it is handed and answers every read from
 * them, so a test observes what the adapter published instead of a prebuilt
 * reply. Like R2 it derives the object's SHA-256 from what it stored, so
 * publishing the wrong bytes or the wrong key cannot verify afterwards.
 *
 * `stored` is writable so a test can seed the object a repair has to replace.
 */
const recordingBucket = (): {
  readonly bucket: R2Bucket
  readonly puts: ReadonlyArray<PutCall>
  readonly stored: Map<string, StoredObject>
} => {
  const puts: Array<PutCall> = []
  const stored = new Map<string, StoredObject>()
  const objectFor = (key: string): R2ObjectBody | null => {
    const entry = stored.get(key)
    if (entry === undefined) return null
    return object(key, {
      body: new Response(entry.bytes).body!,
      size: entry.bytes.byteLength,
      ...(entry.checksum === undefined ? {} : { checksum: entry.checksum })
    })
  }
  const bucket = {
    get: async (key: string) => objectFor(key),
    head: async (key: string) => objectFor(key),
    put: async (key: string, body: Uint8Array, options?: R2PutOptions) => {
      const bytes = Uint8Array.from(body)
      puts.push({ key, bytes, options })
      if (options?.onlyIf !== undefined && stored.has(key)) return null
      stored.set(key, { bytes, checksum: sha256(bytes) })
      return objectFor(key)
    }
  } as unknown as R2Bucket
  return { bucket, puts, stored }
}

const readBody = async (body: BodyInit): Promise<ReadonlyArray<number>> =>
  Array.from(new Uint8Array(await new Response(body).arrayBuffer()))

describe("R2 content store", () => {
  let errors: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  afterEach(() => {
    errors.mockRestore()
  })

  it("reports an object without a verified provider checksum as absent", async () => {
    const digest = digestOf("artifact")
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      }
    })
    const legacy = object(digest, { body })
    const bucket = {
      get: async () => legacy,
      head: async () => legacy
    } as unknown as R2Bucket
    const store = makeContentStore(bucket)

    // Refusing instead would answer 503, which clients retry rather than treat
    // as a miss, so the digest could never be republished and repaired.
    await expect(store.get(digest)).resolves.toBeNull()
    await expect(store.has(digest)).resolves.toBe(false)
    expect(cancelled).toBe(true)
    expect(String(errors.mock.calls[0]?.[0])).toContain(digest)
  })

  it("reports a checksum that does not match the content address as absent", async () => {
    const digest = digestOf("artifact")
    const corrupt = object(digest, { checksum: digestBytes("0".repeat(64)) })
    const bucket = { head: async () => corrupt } as unknown as R2Bucket

    await expect(makeContentStore(bucket).has(digest)).resolves.toBe(false)
    expect(String(errors.mock.calls[0]?.[0])).toContain("mismatched SHA-256 checksum")
  })

  it("keeps one unverifiable object from failing a whole findMissing batch", async () => {
    const good = digestOf("good")
    const bad = digestOf("bad")
    const bucket = {
      head: async (key: string) => key === good ? object(good, { checksum: digestBytes(good) }) : object(bad, {})
    } as unknown as R2Bucket

    const present = await makeContentStore(bucket).presentDigests([good, bad])

    expect([...present]).toEqual([good])
  })

  it("refuses an object whose key or size leaves the content-store invariant", async () => {
    const digest = digestOf("artifact")
    const foreign = object("0".repeat(64), { checksum: digestBytes(digest) })
    const oversized = { ...object(digest, { checksum: digestBytes(digest) }), size: -1 } as unknown as R2ObjectBody

    // A wrong key or an impossible size is a broken bucket, not a repairable
    // object: republishing the bytes would not change the answer, so this
    // stays a storage refusal rather than becoming a miss.
    await expect(makeContentStore({ head: async () => foreign } as unknown as R2Bucket).has(digest)).rejects
      .toThrow(/outside the content-store invariant/)
    await expect(makeContentStore({ get: async () => oversized } as unknown as R2Bucket).get(digest)).rejects
      .toThrow(/outside the content-store invariant/)
    await expect(
      makeContentStore({ head: async () => foreign } as unknown as R2Bucket).presentDigests([digest])
    ).rejects.toThrow(/outside the content-store invariant/)
  })

  it("probes a large findMissing batch sixteen objects at a time", async () => {
    const digests = Array.from({ length: 20 }, (_, index) => digestOf(`artifact-${index}`))
    let inFlight = 0
    let peak = 0
    const bucket = {
      head: async (key: string) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        inFlight -= 1
        return object(key, { checksum: digestBytes(key) })
      }
    } as unknown as R2Bucket

    const present = await makeContentStore(bucket).presentDigests(digests)

    expect([...present].sort()).toEqual([...digests].sort())
    expect(peak).toBe(16)
  })

  it("closes the repair loop: an unverifiable object reads as absent, is republished, and then reads", async () => {
    const digest = digestOf("artifact")
    const bytes = Uint8Array.from(new TextEncoder().encode("artifact"))
    let stored = object(digest, {})
    const bucket = {
      head: async () => stored,
      get: async () => stored,
      put: async (_key: string, _body: unknown, options?: R2PutOptions) => {
        if (options?.onlyIf !== undefined) return null
        stored = object(digest, { checksum: digestBytes(digest) })
        return stored
      }
    } as unknown as R2Bucket
    const store = makeContentStore(bucket)

    expect(await store.has(digest)).toBe(false)
    expect(await store.put(digest, bytes)).toBe("inserted")
    expect(await store.has(digest)).toBe(true)
    expect(await store.get(digest)).not.toBeNull()
  })

  it("repairs an invalid object with already address-verified request bytes", async () => {
    const bytes = Uint8Array.from(new TextEncoder().encode("artifact"))
    const digest = digestOf("artifact")
    const legacy = object(digest, {})
    const repaired = object(digest, { checksum: digestBytes(digest) })
    const puts: Array<R2PutOptions | undefined> = []
    const bucket = {
      head: async () => legacy,
      put: async (_key: string, _body: unknown, options?: R2PutOptions) => {
        puts.push(options)
        return puts.length === 1 ? null : repaired
      }
    } as unknown as R2Bucket

    await expect(makeContentStore(bucket).put(digest, bytes)).resolves.toBe("inserted")
    expect(puts).toHaveLength(2)
    expect(puts[0]?.onlyIf).toBeDefined()
    expect(puts[1]?.onlyIf).toBeUndefined()
    expect(Array.from(puts[1]?.sha256 as Uint8Array)).toEqual(Array.from(new Uint8Array(digestBytes(digest))))
  })

  it("reports an object R2 does not hold as absent", async () => {
    const bucket = { get: async () => null, head: async () => null } as unknown as R2Bucket
    const store = makeContentStore(bucket)

    await expect(store.get(digestOf("absent"))).resolves.toBeNull()
    await expect(store.has(digestOf("absent"))).resolves.toBe(false)
    expect(errors).not.toHaveBeenCalled()
  })

  it("reports a checksum of the wrong length as a mismatch rather than reading past it", async () => {
    const digest = digestOf("artifact")
    const truncated = object(digest, { checksum: digestBytes(digest).slice(0, 16) })
    const bucket = { head: async () => truncated } as unknown as R2Bucket

    await expect(makeContentStore(bucket).has(digest)).resolves.toBe(false)
    expect(String(errors.mock.calls[0]?.[0])).toContain("mismatched SHA-256 checksum")
  })

  it("still reports an unverifiable object absent when its body refuses to be cancelled", async () => {
    const digest = digestOf("artifact")
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("cancel refused")
      }
    })
    const bucket = { get: async () => object(digest, { body }) } as unknown as R2Bucket

    await expect(makeContentStore(bucket).get(digest)).resolves.toBeNull()
  })

  it("publishes a first insert and verifies what R2 stored", async () => {
    const { bucket, puts, stored } = recordingBucket()
    const store = makeContentStore(bucket)

    await expect(store.put(artifactDigest, artifactBytes)).resolves.toBe("inserted")

    // What reaches the bucket is the contract: the content address as the key,
    // the request bytes unchanged, the address as the provider checksum, and
    // the conditional header that makes the first writer win.
    expect(puts).toHaveLength(1)
    expect(puts[0]?.key).toBe(artifactDigest)
    expect(Array.from(puts[0]?.bytes ?? [])).toEqual(Array.from(artifactBytes))
    expect(Array.from(puts[0]?.options?.sha256 as Uint8Array)).toEqual(
      Array.from(new Uint8Array(digestBytes(artifactDigest)))
    )
    expect((puts[0]?.options?.onlyIf as Headers).get("if-none-match")).toBe("*")
    expect(Array.from(stored.get(artifactDigest)?.bytes ?? [])).toEqual(Array.from(artifactBytes))

    await expect(store.has(artifactDigest)).resolves.toBe(true)
    expect(await readBody((await store.get(artifactDigest))!.body)).toEqual(Array.from(artifactBytes))
  })

  it("leaves an already-published object exactly as the first writer stored it", async () => {
    const { bucket, puts, stored } = recordingBucket()
    stored.set(artifactDigest, { bytes: artifactBytes, checksum: sha256(artifactBytes) })
    const store = makeContentStore(bucket)

    await expect(store.put(artifactDigest, artifactBytes)).resolves.toBe("present")

    // Only the losing conditional attempt reaches R2; nothing rewrites the row.
    expect(puts).toHaveLength(1)
    expect(puts[0]?.options?.onlyIf).toBeDefined()
    expect(Array.from(stored.get(artifactDigest)?.bytes ?? [])).toEqual(Array.from(artifactBytes))
    expect(await readBody((await store.get(artifactDigest))!.body)).toEqual(Array.from(artifactBytes))
  })

  it("repairs an unverifiable object with the published bytes and then serves them", async () => {
    const { bucket, puts, stored } = recordingBucket()
    stored.set(artifactDigest, { bytes: Uint8Array.from([1, 2, 3]), checksum: undefined })
    const store = makeContentStore(bucket)

    await expect(store.put(artifactDigest, artifactBytes)).resolves.toBe("inserted")

    expect(puts.map((call) => call.key)).toEqual([artifactDigest, artifactDigest])
    expect(puts[0]?.options?.onlyIf).toBeDefined()
    expect(puts[1]?.options?.onlyIf).toBeUndefined()
    expect(Array.from(puts[1]?.bytes ?? [])).toEqual(Array.from(artifactBytes))
    expect(Array.from(puts[1]?.options?.sha256 as Uint8Array)).toEqual(
      Array.from(new Uint8Array(digestBytes(artifactDigest)))
    )
    // The legacy bytes are gone, and the digest now reads back as itself.
    expect(Array.from(stored.get(artifactDigest)?.bytes ?? [])).toEqual(Array.from(artifactBytes))
    expect(await readBody((await store.get(artifactDigest))!.body)).toEqual(Array.from(artifactBytes))
  })

  it("gives up when the conditional publication keeps losing to an object it cannot find", async () => {
    const digest = digestOf("artifact")
    const bytes = Uint8Array.from(new TextEncoder().encode("artifact"))
    let heads = 0
    const bucket = { put: async () => null, head: async () => (heads += 1, null) } as unknown as R2Bucket

    await expect(makeContentStore(bucket).put(digest, bytes)).rejects.toThrow("lost its object repeatedly")
    expect(heads).toBe(3)
  })

  it("refuses a repair R2 does not acknowledge", async () => {
    const digest = digestOf("artifact")
    const bytes = Uint8Array.from(new TextEncoder().encode("artifact"))
    const corrupt = object(digest, { checksum: digestBytes("0".repeat(64)) })
    const bucket = { put: async () => null, head: async () => corrupt } as unknown as R2Bucket

    await expect(makeContentStore(bucket).put(digest, bytes)).rejects.toThrow(
      "did not return the repaired content object"
    )
  })

  it("reports the digests R2 does not hold as missing from a batch", async () => {
    const present = digestOf("present")
    const absent = digestOf("absent")
    const stored = object(present, { checksum: digestBytes(present) })
    const bucket = { head: async (key: string) => (key === present ? stored : null) } as unknown as R2Bucket

    await expect(makeContentStore(bucket).presentDigests([absent, present])).resolves.toEqual(new Set([present]))
  })
})
