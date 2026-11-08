import { Effect, Option, Redacted } from "effect"
import { expect, test } from "vitest"
import * as Keys from "./SessionKeys.ts"

const SECRET = "legacy-test-signing-secret-".padEnd(64, "7")
const NEXT = "new-test-signing-secret-".padEnd(64, "9")
const makeKeys = () => Effect.runPromise(Keys.make(Redacted.make(SECRET), {
  secrets: { legacy: Redacted.make(SECRET), next: Redacted.make(NEXT) },
  sealSecret: Redacted.make(SECRET),
}))

test("verification reports the configured signing key, while sealing remains pinned", async () => {
  const old = await Effect.runPromise(Keys.make(Redacted.make(SECRET)))
  const keys = await makeKeys()
  const signed = await Effect.runPromise(keys.sign("session", "opaque-token", "next"))
  expect(await Effect.runPromise(keys.verify("session", signed))).toEqual(Option.some({ value: "opaque-token", keyId: "next" }))
  expect(await Effect.runPromise(keys.verify("run", signed))).toEqual(Option.none())
  const sealed = await Effect.runPromise(old.seal(Redacted.make("token-sentinel"), { id: "row", name: "github_access", version: 1 }))
  expect(Redacted.value(await Effect.runPromise(keys.open(sealed, { id: "row", name: "github_access", version: 1 })))).toBe("token-sentinel")
})

test("key ids cannot share a secret because verification must identify exactly one key", () => {
  expect(Keys.decodeSecrets(Redacted.make(JSON.stringify({ legacy: SECRET, next: SECRET })))).toEqual(Option.none())
  expect(Keys.decodeSecrets(Redacted.make("not json"))).toEqual(Option.none())
  expect(Keys.decodeSecrets(Redacted.make(JSON.stringify({ legacy: "short" })))).toEqual(Option.none())
})
