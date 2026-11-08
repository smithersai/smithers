import { CredentialCipher, WebCryptoCipher } from "@smthrs/control"
import { digestSync } from "@smthrs/crypto"
import { Core } from "@smthrs/integrations"
import { Effect, Option, Redacted } from "effect"

export const MIN_SECRET_LENGTH = 32
export const LEGACY_KEY = "legacy"
export type Purpose = "session" | "sign_in" | "handoff" | "handoff_request" | "run"
export type SealContext = CredentialCipher.Context
export interface Verified {
  readonly value: string
  readonly keyId: string
}
export interface SessionKeys {
  readonly keyIds: ReadonlyArray<string>
  readonly token: Effect.Effect<string>
  readonly sign: (purpose: Purpose, value: string, keyId?: string) => Effect.Effect<string>
  readonly verify: (purpose: Purpose, signed: string | undefined) => Effect.Effect<Option.Option<Verified>>
  readonly seal: (plaintext: Redacted.Redacted<string>, context: SealContext) => Effect.Effect<CredentialCipher.Sealed>
  readonly open: CredentialCipher.Service["open"]
}
export const digest = (value: string): string => digestSync(value)
const hexToBase64 = (hex: string) => btoa(String.fromCharCode(...hex.match(/../g)!.map(pair => parseInt(pair, 16))))

/** The legacy secret remains the seal fallback, so deploying signing rotation never changes ciphertext keys. */
export const make = (secret: Redacted.Redacted<string>, options: {
  readonly sealSecret?: Redacted.Redacted<string>
  readonly secrets?: Readonly<Record<string, Redacted.Redacted<string>>>
} = {}) => Effect.gen(function* () {
  const secrets = options.secrets ?? { [LEGACY_KEY]: secret }
  const keyIds = Object.keys(secrets).sort()
  const cipher = yield* WebCryptoCipher.make({
    key: Redacted.make(hexToBase64(digest(`smithers-seal:${Redacted.value(options.sealSecret ?? secret)}`))),
  }).pipe(Effect.orDie)
  const cookies = yield* Core.CookieKeys.make(secrets, LEGACY_KEY)
  return {
    ...cookies,
    seal: (plaintext, context) => cipher.seal(plaintext, context).pipe(Effect.orDie),
    open: cipher.open,
  } satisfies SessionKeys
})

/** A configuration error returns no values, so invalid secret maps never enter logs or Config error text. */
export const decodeSecrets = (encoded: Redacted.Redacted<string>): Option.Option<Readonly<Record<string, Redacted.Redacted<string>>>> => {
  try {
    const parsed: unknown = JSON.parse(Redacted.value(encoded))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return Option.none()
    const entries = Object.entries(parsed)
    if (entries.length === 0 || entries.some(([id, value]) => !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof value !== "string" || value.length < MIN_SECRET_LENGTH)) return Option.none()
    // Two ids for the same secret make the verifying key ambiguous and defeat row-key equality.
    if (new Set(entries.map(([, value]) => digest(value as string))).size !== entries.length) return Option.none()
    return Option.some(Object.fromEntries(entries.map(([id, value]) => [id, Redacted.make(value as string)])))
  } catch { return Option.none() }
}
