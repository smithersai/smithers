import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { beforeAll, describe, test } from "vitest"
import type * as CredentialCipher from "../src/CredentialCipher.ts"
import * as ScopedToken from "../src/ScopedToken.ts"
import * as WebCryptoCipher from "../src/WebCryptoCipher.ts"

const signingKey = "bench-gateway-root-secret-0123456789abcdef"
const cipherKeyBase64 = Buffer.from(new Uint8Array(32).fill(0x42)).toString("base64")
const cipherContext: CredentialCipher.Context = { id: "cred-1", name: "anthropic", version: 1 }

describe("control hot paths", () => {
  let token = ""
  let claims!: ScopedToken.Claims
  let cipher!: CredentialCipher.Service

  beforeAll(async () => {
    const minted = await Effect.runPromise(
      ScopedToken.mint({
        key: signingKey,
        scopes: ["read:runs", "approve:runs", "write:runs"],
        runId: "run-bench-1",
        flowId: "deploy",
        ttlMillis: 300_000,
        now: () => 1_000
      })
    )
    token = minted.token
    claims = minted.claims
    cipher = await Effect.runPromise(
      WebCryptoCipher.make({ key: Redacted.make(cipherKeyBase64) })
    )
  })

  test("ScopedToken.mint", async ({ bench }) => {
    await bench("mint signed smt1 scoped token", async () => {
      await Effect.runPromise(
        ScopedToken.mint({
          key: signingKey,
          scopes: ["read:runs", "approve:runs"],
          runId: "run-bench-1",
          ttlMillis: 60_000,
          now: () => 1_000
        })
      )
    }).run({ time: 120, warmupTime: 30 })
  })

  test("ScopedToken.verify and authorizes", async ({ bench }) => {
    await bench("verify smt1 scoped token + authorize RPC call", async () => {
      const verified = await Effect.runPromise(ScopedToken.verify(signingKey, token, 5_000))
      ScopedToken.authorizes(verified, {
        rpc: "Approve",
        payload: { runId: "run-bench-1", flowId: "deploy" }
      })
    }).run({ time: 120, warmupTime: 30 })
  })

  test("ScopedToken.authorizes sync check", async ({ bench }) => {
    await bench("authorize 4 procedure calls against decoded claims", () => {
      ScopedToken.authorizes(claims, { rpc: "List", payload: { runId: "run-bench-1", flowId: "deploy" } })
      ScopedToken.authorizes(claims, { rpc: "Approve", payload: { runId: "run-bench-1", flowId: "deploy" } })
      ScopedToken.authorizes(claims, { rpc: "Start", payload: { runId: "run-bench-1", flowId: "deploy" } })
      ScopedToken.authorizes(claims, { rpc: "Cancel", payload: { runId: "run-bench-1", flowId: "deploy" } })
    }).run({ time: 120, warmupTime: 30 })
  })

  test("WebCryptoCipher seal + open", async ({ bench }) => {
    const secret = Redacted.make("sk-ant-api03-credential-payload-0123456789")
    await bench("AES-GCM seal + open credential envelope", async () => {
      const sealed = await Effect.runPromise(cipher.seal(secret, cipherContext))
      await Effect.runPromise(cipher.open(sealed, cipherContext))
    }).run({ time: 120, warmupTime: 30 })
  })
})
