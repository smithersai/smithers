// An overflow box's egress when a stored credential URL names no host (worker/secrets/SandboxEgress.ts
// `forwardOverflow`): refused with a record before any credential is derived, opened or sent. The real egress runs over
// Effect's real fetch client; the network and Postgres are watched and never reached.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Logger, Redacted } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { SecretKeys } from "./Keys.ts"
import * as SandboxEgress from "./SandboxEgress.ts"

const KEY = Redacted.make("0123456789abcdef".repeat(4))
const guest: SandboxEgress.Guest = { repoId: "github/acme/widgets", branchId: "overflow-box", generation: 1 }
const credentials: SandboxEgress.OverflowCredentials = {
  repoId: guest.repoId,
  origin: "https://smithers.test",
  token: { ciphertext: "c2VhbGVk", nonce: "bm9uY2U=", keyVersion: 1 },
  personId: "person-admin",
  connectionId: "connection-1",
  baseUrl: "https://api.model.test",
}

const box = (overflow: SandboxEgress.OverflowCredentials) => {
  const logs: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const sent: Array<string> = []
  const fetch: typeof globalThis.fetch = (input) => {
    sent.push(input instanceof Request ? input.url : String(input))
    return Promise.resolve(new Response("reached"))
  }
  const handler = HttpEffect.toWebHandler(
    SandboxEgress.forwardOverflow(guest, overflow).pipe(
      Effect.provide(SecretKeys.layer(KEY)),
      // Never connected: a refusal before the policy exists reads no row.
      Effect.provide(Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provide(Logger.layer([Logger.make((options) => void logs.push(StructuredLogger.formatStructured.log(options)))])),
    ),
  )
  return { handler, logs, sent }
}

describe("forwardOverflow", () => {
  test.each([
    ["the key's base URL", { baseUrl: "not a url" }, "overflow_base_url"],
    ["the deployment's origin", { origin: "" }, "overflow_origin"],
  ])("a stored %s that names no host is refused 503 with one secrets.egress warning, and nothing is sent", async (_, bad, errorCode) => {
    const { handler, logs, sent } = box({ ...credentials, ...bad })
    const answer = await handler(new Request("https://api.model.test/v1/messages", { method: "POST", body: "{}" }))
    expect([answer.status, await answer.text()]).toEqual([503, "unavailable"])
    expect(sent).toEqual([])
    const lines = logs.filter((log) => log.message === "secrets.egress")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: "WARN", annotations: { egress: "overflow", outcome: "unavailable", errorCode } })
    // The record names a code, never the stored URL.
    expect(JSON.stringify(logs)).not.toContain("not a url")
  })
})
