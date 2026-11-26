import { ConfigProvider, Effect, Logger, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "vitest"
import * as Config from "./Config.vibe"
import { DomainProvider, type Provider } from "./Provider.vibe"

const configured = <A, E, R>(effect: Effect.Effect<A, E, R>, values: Record<string, string>) => effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)), Effect.provide(FetchHttpClient.layer))

test("unset is off; development defaults to localhost DNS", async () => {
  expect(await Effect.runPromise(configured(Config.provider(), {}))).toEqual(Option.none())
  const p = Option.getOrThrow<Provider>(await Effect.runPromise(configured(Config.provider({ dev: true }), {})))
  expect([p.name, p.zone, p.target]).toEqual(["dns", "localhost", "domains.localhost"])
})

test.each([false, true])("configured DNS resolver, explicit target=%s", async explicit => {
  const values = { DOMAINS_PROVIDER: "dns", DOMAINS_ZONE: "example.com", ...(explicit ? { DOMAINS_CNAME_TARGET: "route.test", DOMAINS_DOH_URL: "https://resolver.test/query" } : {}) }
  const calls: Array<string> = []
  const fetch: typeof globalThis.fetch = async input => { calls.push(String(input)); return Response.json({ Status: 0 }) }
  await Effect.runPromise(configured(Effect.gen(function* () {
    const p = Option.getOrThrow<Provider>(yield* Config.provider())
    expect([p.name, p.zone, p.target]).toEqual(["dns", "example.com", explicit ? "route.test" : "domains.example.com"])
    yield* p.ensure("www.example.org")
  }), values).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)))
  expect(calls).toHaveLength(1)
  expect(calls.every(url => url.startsWith(explicit ? "https://resolver.test/query" : "https://cloudflare-dns.com/dns-query"))).toBe(true)
})

test("cloudflare configuration and DomainProvider layer", async () => {
  const values = { DOMAINS_PROVIDER: "cloudflare", DOMAINS_ZONE: "example.com", DOMAINS_ZONE_ID: "id", DOMAINS_API_TOKEN: "secret" }
  const p = Option.getOrThrow<Provider>(await Effect.runPromise(configured(Config.provider(), values)))
  expect([p.name, p.zone, p.target]).toEqual(["cloudflare", "example.com", "domains.example.com"])
  const service = await Effect.runPromise(configured(Effect.gen(function* () { return yield* DomainProvider }).pipe(Effect.provide(Config.layer({ dev: true }))), {}))
  expect(Option.getOrThrow<Provider>(service).name).toBe("dns")
})

test.each([
  [{ DOMAINS_PROVIDER: "cloudflare" }, "no_zone"],
  [{ DOMAINS_PROVIDER: "dns" }, "no_zone"],
  [{ DOMAINS_PROVIDER: "cloudflare", DOMAINS_ZONE: "example.com" }, "no_zone_id"],
  [{ DOMAINS_PROVIDER: "cloudflare", DOMAINS_ZONE: "example.com", DOMAINS_ZONE_ID: "id" }, "no_token"],
] as const)("missing configuration logs %s", async (values, reason) => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const levels: Array<string> = []
  const result = await Effect.runPromise(configured(Config.provider(), values).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make(entry => { levels.push(entry.logLevel); logs.push(Logger.formatStructured.log(entry)) })]))))
  expect(result).toEqual(Option.none())
  expect(logs).toHaveLength(1)
  expect(levels).toEqual(["Warn"])
  expect(logs[0]).toMatchObject({ message: "domains.off", annotations: { reason } })
  expect(JSON.stringify(logs)).not.toContain("secret")
})

test("unknown provider fails configuration", async () => {
  const error = await Effect.runPromise(configured(Effect.flip(Config.provider()), { DOMAINS_PROVIDER: "unknown" }))
  expect(error._tag).toBe("ConfigError")
})
