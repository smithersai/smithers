import { CredentialCipher, WebCryptoCipher } from "@smthrs/control"
import { digestSync } from "@smthrs/crypto"
import { Core } from "@smthrs/integrations"
import { Effect, Option, Redacted } from "effect"

// Sign-in's keys (docs/features/sign-in.md#keys), all from one secret, SESSION_SECRET: cookies are signed with
// HMAC-SHA256 (`@smthrs/integrations`' `Core.Signature`), and GitHub's tokens and the PKCE verifier are sealed with
// AES-256-GCM (`@smthrs/control`'s `WebCryptoCipher`) under a key derived from it. A database read alone signs nobody
// in: Postgres holds only a token's SHA-256 and sealed values.

/** The shortest SESSION_SECRET sign-in accepts. Alchemy generates 64 hexadecimal characters. */
export const MIN_SECRET_LENGTH = 32

/**
 * What a signed value is for, so a value signed for one use never verifies as another: a cookie (`session`,
 * `sign_in`, an alias's hand-off nonce `handoff`), an alias's hand-off request to `APP_DOMAIN` (`handoff_request`,
 * decision 0130) or a run credential (`run`, worker/RunCredentials.ts).
 */
export type Purpose = "session" | "sign_in" | "handoff" | "handoff_request" | "run"

/** What a sealed value is and whose it is; the cipher authenticates both with the ciphertext. */
export type SealContext = CredentialCipher.Context

export interface SessionKeys {
  /** A fresh random token: 256 bits, base64url. */
  readonly token: Effect.Effect<string>
  /** `value.<signature>`, for a cookie. */
  readonly sign: (purpose: Purpose, value: string) => Effect.Effect<string>
  /** The value a signed cookie carries, when we signed it for `purpose`. */
  readonly verify: (purpose: Purpose, signed: string | undefined) => Effect.Effect<Option.Option<string>>
  readonly seal: (plaintext: Redacted.Redacted<string>, context: SealContext) => Effect.Effect<CredentialCipher.Sealed>
  /** Fails with `PersistenceError` when the sealed value doesn't open under this key and context. */
  readonly open: CredentialCipher.Service["open"]
}

/** A token's SHA-256, as Postgres keeps it. */
export const digest = (value: string): string => digestSync(value)

/** A SHA-256 digest's 64 hexadecimal characters as the 32 bytes' base64, the key form the cipher takes. */
const hexToBase64 = (hex: string) => btoa(String.fromCharCode(...hex.match(/../g)!.map((pair) => parseInt(pair, 16))))

/** The keys under `secret`. Dies when the host has no WebCrypto, which every supported host provides. */
export const make = (secret: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const hmacSecret = Redacted.value(secret)
    const cipher = yield* WebCryptoCipher.make({
      key: Redacted.make(hexToBase64(digest(`smithers-seal:${hmacSecret}`))),
    }).pipe(Effect.orDie)
    const signature = (purpose: Purpose, value: string) =>
      Core.Signature.computeHmacSha256Hex(`${purpose}:${value}`, hmacSecret)
    return {
      // A PKCE verifier is 32 random bytes as base64url: exactly a session or `state` token.
      token: Core.Pkce.createCodeVerifier(32).pipe(Effect.orDie),
      sign: (purpose, value) => Effect.map(signature(purpose, value), (mac) => `${value}.${mac}`),
      verify: (purpose, signed) => {
        const dot = signed?.lastIndexOf(".") ?? -1
        if (signed === undefined || dot <= 0) return Effect.succeedNone
        const value = signed.slice(0, dot)
        return Core.Signature.verifySignature({
          payload: `${purpose}:${value}`,
          secret: hmacSecret,
          signature: signed.slice(dot + 1),
          prefix: "",
        }).pipe(Effect.map((ok) => (ok ? Option.some(value) : Option.none())))
      },
      seal: (plaintext, context) => cipher.seal(plaintext, context).pipe(Effect.orDie),
      open: cipher.open,
    } satisfies SessionKeys
  })
