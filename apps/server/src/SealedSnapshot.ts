import { Data, Effect } from "effect"

export class SnapshotFailure extends Data.TaggedError("SnapshotFailure")<{ readonly code: string }> {}
const failed = (code: string) => new SnapshotFailure({ code })
const utf8 = new TextEncoder()
export const base64 = (value: Uint8Array): string => {
  let encoded = ""
  for (let start = 0; start < value.length; start += 16_384) encoded += String.fromCharCode(...value.subarray(start, start + 16_384))
  return btoa(encoded)
}

/** Explicit types preserve structured storage values without ambiguous tags in user objects. */
export const encodeStored = (value: unknown, seen = new Set<object>()): unknown => {
  if (value === null) return ["null"]
  if (value === undefined) return ["undefined"]
  if (typeof value === "string" || typeof value === "boolean") return [typeof value, value]
  if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)]
  if (typeof value === "bigint") return ["bigint", String(value)]
  if (typeof value !== "object") throw failed("unsupported_storage_value")
  if (seen.has(value)) throw failed("cyclic_storage_value")
  seen.add(value)
  try {
    if (value instanceof Date) return ["date", value.toISOString()]
    if (value instanceof ArrayBuffer) return ["ArrayBuffer", base64(new Uint8Array(value))]
    if (ArrayBuffer.isView(value)) return [value.constructor.name, base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))]
    if (Array.isArray(value)) return ["array", value.map(item => encodeStored(item, seen))]
    if (value instanceof Map) return ["map", [...value].map(([key, item]) => [encodeStored(key, seen), encodeStored(item, seen)])]
    if (value instanceof Set) return ["set", [...value].map(item => encodeStored(item, seen))]
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw failed("unsupported_storage_value")
    return ["object", Object.entries(value).map(([key, item]) => [key, encodeStored(item, seen)])]
  } finally { seen.delete(value) }
}

export interface SnapshotMetadata {
  readonly version: 1
  readonly schema: "smithers-do-storage/v1"
  readonly keyVersion: "model-vault:v1" | null
  readonly migrationId: string
  readonly binding: string
  readonly objectId: string
  readonly sourceRevision: string
  readonly sourceVersion: string
  readonly capturedAt: string
}
export interface SealedSnapshot {
  readonly metadata: SnapshotMetadata
  readonly algorithm: "RSA-OAEP-256+A256GCM"
  readonly wrappedKey: string
  readonly nonce: string
  readonly ciphertext: string
}

/** The owning isolate exports ciphertext only; the recipient private key never reaches it. */
export const sealSnapshot = (metadata: SnapshotMetadata, values: unknown, recipient: JsonWebKey): Effect.Effect<SealedSnapshot, SnapshotFailure> =>
  Effect.gen(function* () {
    if (recipient.kty !== "RSA" || ["d", "p", "q", "dp", "dq", "qi", "oth"].some(name => name in recipient) ||
      !recipient.n || !recipient.e || recipient.n.length < 342) return yield* Effect.fail(failed("invalid_export_recipient"))
    const plaintext = yield* Effect.try({ try: () => utf8.encode(JSON.stringify(values)), catch: () => failed("unserializable_snapshot") })
    return yield* Effect.gen(function* () {
    if (plaintext.byteLength > 8_000_000) return yield* Effect.fail(failed("snapshot_requires_paged_export"))
    const publicKey = yield* Effect.tryPromise({ try: () => crypto.subtle.importKey("jwk", recipient, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["wrapKey"]), catch: () => failed("invalid_export_recipient") })
    const key = yield* Effect.tryPromise({ try: () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]), catch: () => failed("snapshot_encryption_failed") })
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = yield* Effect.tryPromise({ try: () => crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: utf8.encode(JSON.stringify(metadata)) }, key, plaintext), catch: () => failed("snapshot_encryption_failed") })
    const wrapped = yield* Effect.tryPromise({ try: () => crypto.subtle.wrapKey("raw", key, publicKey, { name: "RSA-OAEP" }), catch: () => failed("snapshot_encryption_failed") })
    return { metadata, algorithm: "RSA-OAEP-256+A256GCM" as const, wrappedKey: base64(new Uint8Array(wrapped)), nonce: base64(nonce), ciphertext: base64(new Uint8Array(ciphertext)) }
    }).pipe(Effect.ensuring(Effect.sync(() => plaintext.fill(0))))
  })

/** Fixed-size digest comparison; neither secret nor request material is logged. */
export const authenticatedExport = (authorization: string | null, configured: string | undefined): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    if (!configured || configured.length < 43 || !authorization?.startsWith("Bearer ")) return false
    const supplied = authorization.slice(7)
    if (supplied.length > 200) return false
    const hashes = yield* Effect.tryPromise({ try: () => Promise.all([
      crypto.subtle.digest("SHA-256", utf8.encode(configured)), crypto.subtle.digest("SHA-256", utf8.encode(supplied))
    ]), catch: () => failed("authentication_failed") }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (hashes === undefined) return false
    const a = new Uint8Array(hashes[0]!), b = new Uint8Array(hashes[1]!)
    let different = 0
    for (let i = 0; i < a.length; i++) different |= a[i]! ^ b[i]!
    return different === 0
  })
