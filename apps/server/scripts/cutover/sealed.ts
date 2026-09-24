import type { SealedSnapshot } from "../../src/SealedSnapshot"

const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
export interface SnapshotPayload {
  entries: Array<[string, unknown]>; alarm: number | null; migrationContext?: { keyVersion: "model-vault:v1"; modelVaultKey: string | null }
  /** Raw rows of the reserved fenced-alarm table; never part of product `entries`. */
  cutoverAlarmMarkers?: string[]
}
export const openSnapshot = async (sealed: SealedSnapshot, privateJwk: JsonWebKey): Promise<SnapshotPayload> => {
  if (sealed.algorithm !== "RSA-OAEP-256+A256GCM" || sealed.metadata.version !== 1 || sealed.metadata.schema !== "smithers-do-storage/v1") throw new Error("Unsupported encrypted snapshot")
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["unwrapKey"])
  const key = await crypto.subtle.unwrapKey("raw", bytes(sealed.wrappedKey), privateKey, { name: "RSA-OAEP" }, { name: "AES-GCM", length: 256 }, false, ["decrypt"])
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(sealed.nonce), additionalData: new TextEncoder().encode(JSON.stringify(sealed.metadata)) }, key, bytes(sealed.ciphertext)))
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext))
    if (!decoded || typeof decoded !== "object" || !("entries" in decoded) || !Array.isArray(decoded.entries) || !("alarm" in decoded)) throw new Error("Invalid snapshot payload")
    return decoded as SnapshotPayload
  } finally { plaintext.fill(0) }
}

export const decodeStored = (encoded: unknown): unknown => {
  if (!Array.isArray(encoded)) throw new Error("Invalid storage encoding")
  const [tag, value] = encoded
  switch (tag) {
    case "undefined": return undefined
    case "null": return null
    case "string": case "boolean": return value
    case "number": return value === "-0" ? -0 : Number(value)
    case "bigint": return BigInt(value)
    case "date": return new Date(value)
    case "array": return value.map(decodeStored)
    case "map": return new Map(value.map(([key, item]: [unknown, unknown]) => [decodeStored(key), decodeStored(item)]))
    case "set": return new Set(value.map(decodeStored))
    case "object": return Object.fromEntries(value.map(([key, item]: [string, unknown]) => [key, decodeStored(item)]))
    case "ArrayBuffer": return bytes(value).buffer
    case "Uint8Array": return bytes(value)
    case "Int8Array": return new Int8Array(bytes(value).buffer)
    case "Uint8ClampedArray": return new Uint8ClampedArray(bytes(value).buffer)
    case "Int16Array": return new Int16Array(bytes(value).buffer)
    case "Uint16Array": return new Uint16Array(bytes(value).buffer)
    case "Int32Array": return new Int32Array(bytes(value).buffer)
    case "Uint32Array": return new Uint32Array(bytes(value).buffer)
    case "Float32Array": return new Float32Array(bytes(value).buffer)
    case "Float64Array": return new Float64Array(bytes(value).buffer)
    case "BigInt64Array": return new BigInt64Array(bytes(value).buffer)
    case "BigUint64Array": return new BigUint64Array(bytes(value).buffer)
    case "DataView": return new DataView(bytes(value).buffer)
    default: throw new Error("Unsupported storage encoding")
  }
}
