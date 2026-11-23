import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, ConfigProvider, Effect, Exit, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import * as Domain from "./Domain.ts"
import * as ElectricAccess from "./ElectricAccess.ts"
import * as ElectricCache from "./ElectricCache.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("apps/mvp infra fuzz invariants", () => {
  it("Domain.AppDomain rejects unset/invalid domains, overlapping redirects/aliases, and workers.dev with redirects or aliases", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        domain: Schema.Union([
          Schema.Undefined,
          Schema.Literals([Domain.WORKERS_DEV, "smithers.sh", "app.example.com", "http://bad.com", "bad host", ""])
        ]),
        redirects: Schema.Literals(["", "www.smithers.sh", "smithers.sh", "a.example.com, b.example.com", "bad host"]),
        aliases: Schema.Literals([
          "",
          "factory.smithers.sh=/acme/app",
          "smithers.sh=/acme/app",
          "www.smithers.sh=/acme/app",
          "bad-entry",
          "dup.example.com=/a,dup.example.com=/b"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ domain, redirects, aliases }) =>
          Effect.gen(function*() {
            const entries: Record<string, string> = {}
            if (domain !== undefined) entries.APP_DOMAIN = domain
            if (redirects !== "") entries.APP_DOMAIN_REDIRECTS = redirects
            if (aliases !== "") entries.APP_ALIASES = aliases
            const provider = ConfigProvider.fromUnknown(entries)
            const exit = yield* Effect.exit(Domain.AppDomain.pipe(Effect.provide(ConfigProvider.layer(provider))))
            if (domain === undefined || domain === "" || domain.includes("://") || domain.includes(" ")) {
              if (!Exit.isFailure(exit)) return false
              return true
            }
            if (domain === Domain.WORKERS_DEV) {
              if (redirects !== "" || aliases !== "") return Exit.isFailure(exit)
              return Exit.isSuccess(exit) && Option.isNone(exit.value)
            }
            if (Exit.isSuccess(exit)) {
              if (Option.isNone(exit.value)) return false
              const host = exit.value.value
              // No redirect or alias may collide with APP_DOMAIN or with each other
              if (host.redirects.includes(host.name)) return false
              if (host.aliases.some((a) => a.host === host.name || host.redirects.includes(a.host))) return false
              const wd = Domain.workerDomain(host)
              if (host.redirects.length === 0 && host.aliases.length === 0 && wd !== host.name) return false
              const binding = Domain.aliasesBinding(host)
              if (host.aliases.length === 0 && binding !== "") return false
              const routes = Domain.docsRoutes(host.name)
              if (routes.some((r) => !r.pattern.startsWith(host.name))) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ElectricAccess.admit ONLY admits GET /v1/shape and ElectricCache.cacheControl/enabledFor never cache SSE, non-200, or private responses", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        method: Schema.Literals(["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"]),
        path: Schema.Union([
          Schema.Literals(["/v1/shape", "/v1/shape/", "/v1/shapes", "/v1/health", "/admin", "/v1/shape/../admin"]),
          Schema.String.pipe(Schema.check(Schema.isMaxLength(40)))
        ]),
        query: Schema.Literals([
          "",
          "?table=items&offset=-1",
          "?live_sse=true",
          "?experimental_live_sse=true",
          "?live=true"
        ]),
        status: Schema.Literals([200, 204, 304, 400, 401, 403, 404, 409, 500, 503]),
        cc: Schema.Union([
          Schema.Undefined,
          Schema.Literals([
            "public, max-age=60",
            "public, max-age=5, stale-while-revalidate=5",
            "private, max-age=60",
            "public, private, max-age=60",
            "public, no-store",
            "public, no-cache",
            "max-age=60",
            "no-store",
            ""
          ])
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ method, path, query, status, cc }) =>
          Effect.sync(() => {
            const safePath = path.startsWith("/") ? path : `/${path}`
            let urlStr: string
            try {
              urlStr = new URL(`${safePath}${query}`, "http://electric").toString()
            } catch {
              return true
            }
            const req = HttpServerRequest.fromWeb(new Request(urlStr, { method }))
            const admitted = ElectricAccess.admit(req)
            const expectedAdmit = method === "GET" && new URL(urlStr).pathname === "/v1/shape"
            if ((admitted._tag === "Admitted") !== expectedAdmit) return false
            if (admitted._tag === "Refused" && admitted.status !== 404) return false

            const enabled = ElectricCache.enabledFor(urlStr)
            const sp = new URL(urlStr).searchParams
            if ((sp.get("live_sse") === "true" || sp.get("experimental_live_sse") === "true") && enabled) return false

            const outCc = ElectricCache.cacheControl(status, cc)
            if (status !== 200 && outCc !== ElectricCache.NO_STORE) return false
            if (cc === undefined && outCc !== ElectricCache.NO_STORE) return false
            if (cc !== undefined && /(private|no-store|no-cache)/i.test(cc) && outCc !== ElectricCache.NO_STORE) {
              return false
            }
            const res = HttpServerResponse.empty({
              status,
              ...(cc === undefined ? {} : { headers: { "cache-control": cc } })
            })
            const wrapped = ElectricCache.cachePolicy(res, enabled)
            if (!enabled && wrapped.headers["cache-control"] !== ElectricCache.NO_STORE) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
