import { digestSync } from "@smthrs/crypto"
import { Effect } from "effect"

export const executionNonce = Effect.sync(() => crypto.randomUUID())

/** A fresh runner token: 32 random bytes as base64url, as `smthrs runner token` makes one. */
export const mintToken = Effect.sync(() => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
})

export const digestToken = (token: string) => Effect.sync(() => digestSync(token))
