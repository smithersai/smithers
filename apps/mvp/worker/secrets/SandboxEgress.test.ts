// An overflow box's egress when a stored credential URL names no host (worker/secrets/SandboxEgress.vibe
// `forwardOverflow`): refused with a record before any credential is derived, opened or sent. The real egress runs over
// Effect's real fetch client; the network and Postgres are watched and never reached.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Logger, Redacted } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { SecretKeys } from "./Keys.vibe"
import * as SandboxEgress from "./SandboxEgress.vibe"

const KEY = Redacted.make("0123456789abcdef".repeat(4))
const guest: SandboxEgress.BranchGuest = { kind: "branch", repoId: "github/acme/widgets", branchId: "overflow-box", generation: 1 }
const installation = (installationId: string, grant: SandboxEgress.Grant | undefined): SandboxEgress.InstallationGuest => ({
  ...guest,
  kind: "installation",
  installationId,
  grant,
})
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

describe("an overflow box that ran for a plugin installation", () => {
  const keyName = `connection:${credentials.connectionId}`
  const overflowBox = (target: SandboxEgress.Guest) => {
    const sent: Array<string> = []
    const fetch: typeof globalThis.fetch = (input) => {
      sent.push(input instanceof Request ? input.url : String(input))
      return Promise.resolve(new Response("reached"))
    }
    const handler = HttpEffect.toWebHandler(
      SandboxEgress.forwardOverflow(target, credentials, ["api.model.test"]).pipe(
        Effect.provide(SecretKeys.layer(KEY)),
        // Never connected: the refusal is recorded through it, and a record that can't be written refuses too.
        Effect.provide(Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(Logger.layer([Logger.make(() => undefined)])),
      ),
    )
    return { handler, sent }
  }
  test.each([
    ["no grant binding", installation("plugin-a@1", undefined)],
    ["a grant that names neither credential nor origin", installation("plugin-a@1", { secrets: new Set(), origins: new Set() })],
    ["the credentials granted but not the key's origin", installation("plugin-a@1", { secrets: new Set([keyName, "overflow:runner-token"]), origins: new Set(["https://elsewhere.test"]) })],
    ["the key's host granted under http only", installation("plugin-a@1", { secrets: new Set([keyName]), origins: new Set(["http://api.model.test"]) })],
    ["the key's host granted on another port only", installation("plugin-a@1", { secrets: new Set([keyName]), origins: new Set(["https://api.model.test:8443"]) })],
  ])("with %s, its request is refused and nothing is sent", async (_, target) => {
    const { handler, sent } = overflowBox(target)
    const answer = await handler(new Request("https://api.model.test/v1/messages", { method: "POST", body: "{}" }))
    expect(answer.status).toBeGreaterThanOrEqual(400)
    expect(sent).toEqual([])
  })
})

describe("a guest's scope and grants", () => {
  const a = installation("plugin-a@1", { secrets: new Set(["STRIPE_KEY"]), origins: new Set(["https://api.stripe.com"]) })
  const unbound = installation("plugin-a@1", undefined)
  test("a branch's own box keeps its scope, holds any of its repository's secrets, and reaches the deployment's hosts", () => {
    expect(SandboxEgress.scopeOf(guest)).toBe(JSON.stringify([guest.repoId, guest.branchId, guest.generation]))
    expect(SandboxEgress.auditScope(guest)).toBe("overflow-box:1")
    expect(SandboxEgress.grants(guest, "ANYTHING")).toBe(true)
    expect(SandboxEgress.reachable(guest, ["registry.npmjs.org"])).toEqual(["registry.npmjs.org"])
    expect(SandboxEgress.boundHosts(guest, ["api.stripe.com"])).toEqual(["api.stripe.com"])
    // Its requests are never refused by a grant: http, a port and any host go on to the policy's own checks.
    for (const url of ["http://anything.test/", "https://anything.test:8443/", "not a url"]) {
      expect(SandboxEgress.refusal(guest, url)).toBeUndefined()
    }
  })
  test("guestOf builds a branch guest and installationGuestOf an installation guest, each explicitly", () => {
    const branch = { owner: "Acme", name: "Widgets", branchId: "b" }
    expect(SandboxEgress.guestOf(branch, 2)).toEqual({ kind: "branch", repoId: "github/acme/widgets", branchId: "b", generation: 2 })
    expect(SandboxEgress.installationGuestOf(branch, 2, "plugin-a@1", undefined)).toEqual({
      kind: "installation",
      repoId: "github/acme/widgets",
      branchId: "b",
      generation: 2,
      installationId: "plugin-a@1",
      grant: undefined,
    })
  })
  test("an installation's scope names it, and it holds and reaches only what its grant names", () => {
    expect(SandboxEgress.scopeOf(a)).toBe(JSON.stringify([guest.repoId, guest.branchId, guest.generation, "plugin-a@1"]))
    expect(SandboxEgress.scopeOf(a)).not.toBe(SandboxEgress.scopeOf({ ...a, installationId: "plugin-b@1" }))
    expect(SandboxEgress.auditScope(a)).toBe("overflow-box:1:plugin-a@1")
    expect([SandboxEgress.grants(a, "STRIPE_KEY"), SandboxEgress.grants(a, "OTHER_KEY")]).toEqual([true, false])
    expect(SandboxEgress.reachable(a, ["registry.npmjs.org"])).toEqual(["api.stripe.com"])
    expect(SandboxEgress.boundHosts(a, ["api.stripe.com", "api.other.example"])).toEqual(["api.stripe.com"])
  })
  test("an installation with no grant binding holds nothing, reaches nothing, and every request is refused grant_missing", () => {
    expect(SandboxEgress.grants(unbound, "STRIPE_KEY")).toBe(false)
    expect(SandboxEgress.reachable(unbound, ["registry.npmjs.org"])).toEqual([])
    expect(SandboxEgress.boundHosts(unbound, ["api.stripe.com"])).toEqual([])
    for (const url of ["https://api.stripe.com/v1", "https://registry.npmjs.org/left-pad", "not a url"]) {
      expect(SandboxEgress.refusal(unbound, url)).toBe("grant_missing")
    }
  })
  test("an origin is granted only as its exact canonical scheme, host and port", () => {
    expect(SandboxEgress.canonicalOrigin("HTTPS://API.Stripe.com:443/v1/charges?x=1")).toBe("https://api.stripe.com")
    expect(SandboxEgress.canonicalOrigin("http://api.stripe.com:80")).toBe("http://api.stripe.com")
    for (const bad of ["api.stripe.com", "not a url", "ftp://api.stripe.com", "https://user:pass@api.stripe.com"]) {
      expect(SandboxEgress.canonicalOrigin(bad), bad).toBeUndefined()
    }
    // A grant entry is an origin and nothing more: a bare host, a path, a query, a fragment or credentials grant nothing.
    const entries = installation("plugin-a@1", {
      secrets: new Set(),
      origins: new Set([
        "HTTPS://API.Stripe.com:443",
        "https://hooks.example:8443",
        "http://plain.example",
        "bare.example",
        "https://path.example/v1",
        "https://query.example/?a=1",
        "https://hash.example/#a",
        "https://user:pass@creds.example",
        "not a url",
      ]),
    })
    expect([...SandboxEgress.grantedOrigins(entries)]).toEqual(["https://api.stripe.com", "https://hooks.example:8443", "http://plain.example"])
    // A secret is bound only to an https origin on the default port.
    expect(SandboxEgress.boundHosts(entries, ["api.stripe.com", "hooks.example", "plain.example", "bare.example"])).toEqual(["api.stripe.com"])
    expect(SandboxEgress.refusal(a, "https://api.stripe.com/v1/charges")).toBeUndefined()
    expect(SandboxEgress.refusal(a, "https://API.STRIPE.COM:443/v1/charges")).toBeUndefined()
    for (
      const url of [
        "http://api.stripe.com/v1/charges",
        "https://api.stripe.com:8443/v1/charges",
        "https://api.stripe.com.evil.example/v1",
        "https://evil.example/?h=api.stripe.com",
        "https://user:pass@api.stripe.com/v1",
        "ftp://api.stripe.com/v1",
        "not a url",
      ]
    ) {
      expect(SandboxEgress.refusal(a, url), url).toBe("origin_not_granted")
    }
    // A grant of the host alone, or of another scheme or port, does not grant the https origin.
    for (const origin of ["api.stripe.com", "http://api.stripe.com", "https://api.stripe.com:8443"]) {
      const other = installation("plugin-a@1", { secrets: new Set(["STRIPE_KEY"]), origins: new Set([origin]) })
      expect(SandboxEgress.refusal(other, "https://api.stripe.com/v1/charges"), origin).toBe("origin_not_granted")
      expect(SandboxEgress.boundHosts(other, ["api.stripe.com"]), origin).toEqual([])
    }
  })
})
