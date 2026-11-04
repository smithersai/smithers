// The platform code of Signature.vibe, which a .vibe file does not import as a value (EK4402).

import { Effect } from "effect"

const encoder = new TextEncoder()
// HMAC zero-pads a key shorter than the hash block, so the empty key and one
// zero byte are the same key. WebCrypto refuses a zero-length raw key.
const keyBytes = (secret: string): Uint8Array<ArrayBuffer> => {
  const bytes = encoder.encode(secret)
  return bytes.length === 0 ? new Uint8Array(1) : bytes
}
// Text is UTF-8, as the provider signed it; bytes are copied when the Effect
// starts, so the caller's array is not read again after that.
export const hmacSha256 = (payload: string | Uint8Array, secret: string): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const data = typeof payload === "string" ? encoder.encode(payload) : new Uint8Array(payload)
    const key = await crypto.subtle.importKey("raw", keyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign"
    ])
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, data))
  })
