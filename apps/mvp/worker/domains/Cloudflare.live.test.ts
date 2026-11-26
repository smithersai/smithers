// The Cloudflare for SaaS adapter (worker/domains/Cloudflare.ts) against the real Cloudflare API (decision 0039 §1).
// It skips, naming what is missing, without DOMAINS_ZONE, DOMAINS_ZONE_ID and DOMAINS_API_TOKEN (a token with
// "SSL and Certificates: Edit" on the zone). It writes: it registers DOMAINS_LIVE_HOSTNAME (a fresh
// `live-<random>.example.com` unless set), reads it back and removes it, so run it by hand from the MacBook, never in CI.
import { Effect, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import * as Cloudflare from "./Cloudflare.vibe"

const zone = process.env.DOMAINS_ZONE
const zoneId = process.env.DOMAINS_ZONE_ID
const token = process.env.DOMAINS_API_TOKEN
const hostname = process.env.DOMAINS_LIVE_HOSTNAME ?? `live-${crypto.randomUUID().slice(0, 8)}.example.com`

const missing = Object.entries({ DOMAINS_ZONE: zone, DOMAINS_ZONE_ID: zoneId, DOMAINS_API_TOKEN: token })
  .filter(([, value]) => value === undefined || value === "").map(([name]) => name)

describe("Cloudflare for SaaS, live", () => {
  test.skipIf(missing.length > 0)(
    `registers a custom hostname once, reads it back pending, and removes it${
      missing.length > 0 ? ` (skipped: set ${missing.join(", ")})` : ""
    }`,
    async () => {
      const provider = await Effect.runPromise(
        Cloudflare.make({
          zone: zone!,
          zoneId: zoneId!,
          target: process.env.DOMAINS_CNAME_TARGET ?? `domains.${zone}`,
          token: Redacted.make(token!),
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      )
      const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
      const created = await run(provider.ensure(hostname))
      try {
        expect(created).toMatchObject({ verification: "pending" })
        expect(created.records[0]).toMatchObject({ type: "CNAME", name: hostname })
        expect((await run(provider.ensure(hostname))).id).toBe(created.id)
        const read = await run(provider.status(created.id, hostname))
        expect(Option.getOrThrow(read).id).toBe(created.id)
      } finally {
        await run(provider.remove(created.id))
      }
      expect(Option.isNone(await run(provider.status(created.id, hostname)))).toBe(true)
    },
  )
})
