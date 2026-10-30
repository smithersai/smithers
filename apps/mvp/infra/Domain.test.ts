// The production hostname a deploy reads (infra/Domain.ts) and the docs site's routes on it (infra/DocsSite.ts).
import { ConfigProvider, Effect, Exit, Option } from "effect"
import { describe, expect, test } from "vitest"
import { DOCS_SITE } from "../src/pwa.ts"
import {
  aliasesBinding,
  AppAliasInvalid,
  AppDomain,
  AppDomainInvalid,
  AppDomainRedirectInvalid,
  docsRoutes,
  workerDomain,
  WORKERS_DEV,
} from "./Domain.ts"

const provided = <A, E>(effect: Effect.Effect<A, E>, env: Record<string, string>) =>
  effect.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))))

const read = (env: Record<string, string>) => Effect.runSyncExit(provided(AppDomain, env))

const refusal = (env: Record<string, string>) => {
  const error = Effect.runSync(provided(Effect.flip(AppDomain), env))
  if (!(error instanceof AppDomainInvalid)) throw new Error(`APP_DOMAIN ${JSON.stringify(env)} failed otherwise`)
  return error
}

describe("APP_DOMAIN", () => {
  test("names the custom domain a production deploy attaches the app to", () => {
    expect(read({ APP_DOMAIN: "example.com" })).toEqual(Exit.succeed(Option.some({ name: "example.com", redirects: [], aliases: [] })))
    expect(read({ APP_DOMAIN: "app.example.co.uk" })).toEqual(
      Exit.succeed(Option.some({ name: "app.example.co.uk", redirects: [], aliases: [] })),
    )
  })

  test("workers.dev deploys with no custom domain", () => {
    expect(read({ APP_DOMAIN: WORKERS_DEV })).toEqual(Exit.succeed(Option.none()))
  })

  test("unset or empty, it stops the deploy and says what to set", () => {
    expect(refusal({ APP_DOMAIN: "" }).value).toBeUndefined()
    const error = refusal({})
    expect(error.value).toBeUndefined()
    expect(error.message).toBe(
      "APP_DOMAIN is unset. Set it to the hostname the app serves at, such as example.com, or to workers.dev to serve " +
        "it only at its workers.dev URL (docs/infrastructure.md#domain).",
    )
  })

  test("refuses anything but a lowercase hostname, and says which value", () => {
    for (const value of [
      "https://example.com",
      "example.com/",
      "example.com:443",
      "Example.com",
      "localhost",
      "-example.com",
      "example..com",
      "*.example.com",
      `${"a".repeat(64)}.com`,
    ]) {
      const error = refusal({ APP_DOMAIN: value })
      expect(error.value).toBe(value)
      expect(error.message).toBe(
        `APP_DOMAIN is "${value}": it must be a hostname such as example.com, with no scheme, port or path, or ` +
          "workers.dev (docs/infrastructure.md#domain).",
      )
    }
  })
})

describe("APP_DOMAIN_REDIRECTS", () => {
  const redirectRefusal = (env: Record<string, string>) => {
    const error = Effect.runSync(provided(Effect.flip(AppDomain), env))
    if (!(error instanceof AppDomainRedirectInvalid)) throw new Error(`${JSON.stringify(env)} failed otherwise`)
    return error
  }

  test("lists the hostnames that answer with a 301 to the domain", () => {
    expect(read({ APP_DOMAIN: "example.com", APP_DOMAIN_REDIRECTS: "www.example.com, old.example.net,," })).toEqual(
      Exit.succeed(Option.some({ name: "example.com", redirects: ["www.example.com", "old.example.net"], aliases: [] })),
    )
    expect(read({ APP_DOMAIN: "example.com", APP_DOMAIN_REDIRECTS: "" })).toEqual(
      Exit.succeed(Option.some({ name: "example.com", redirects: [], aliases: [] })),
    )
  })

  test("refuses an entry that isn't a hostname, the domain itself, or any entry without a domain", () => {
    for (const [env, value] of [
      [{ APP_DOMAIN: "example.com", APP_DOMAIN_REDIRECTS: "www.example.com,https://old.example.com" }, "https://old.example.com"],
      [{ APP_DOMAIN: "example.com", APP_DOMAIN_REDIRECTS: "example.com" }, "example.com"],
      [{ APP_DOMAIN: WORKERS_DEV, APP_DOMAIN_REDIRECTS: "www.example.com" }, "www.example.com"],
    ] as const) {
      const error = redirectRefusal(env)
      expect(error.value).toBe(value)
      expect(error.message).toBe(
        `APP_DOMAIN_REDIRECTS lists "${value}": each entry must be a hostname such as www.example.com, other than ` +
          "APP_DOMAIN, and APP_DOMAIN must name a domain, not workers.dev (docs/infrastructure.md#domain).",
      )
    }
    expect(read({ APP_DOMAIN: WORKERS_DEV, APP_DOMAIN_REDIRECTS: " , " })).toEqual(Exit.succeed(Option.none()))
  })

  test("reach Alchemy as the domain's redirects, and a domain without any as its bare hostname", () => {
    expect(workerDomain({ name: "example.com", redirects: [], aliases: [] })).toBe("example.com")
    expect(workerDomain({ name: "example.com", redirects: ["www.example.com"], aliases: [] })).toEqual({
      name: "example.com",
      redirects: ["www.example.com"],
    })
  })
})

describe("APP_ALIASES", () => {
  const aliasRefusal = (env: Record<string, string>) => {
    const error = Effect.runSync(provided(Effect.flip(AppDomain), env))
    if (!(error instanceof AppAliasInvalid)) throw new Error(`${JSON.stringify(env)} failed otherwise`)
    return error
  }
  const factory = { host: "factory.example.com", path: "/acme/widgets/-/factory" }

  test("lists other hostnames that serve the app, each opening one page", () => {
    expect(read({ APP_DOMAIN: "example.com", APP_ALIASES: "factory.example.com=/acme/widgets/-/factory" })).toEqual(
      Exit.succeed(Option.some({ name: "example.com", redirects: [], aliases: [factory] })),
    )
    expect(read({ APP_DOMAIN: WORKERS_DEV, APP_ALIASES: " " })).toEqual(Exit.succeed(Option.none()))
  })

  test("refuses an entry that isn't host=path, uses the domain's own hostnames, or has no domain", () => {
    for (const [env, value] of [
      [{ APP_DOMAIN: "example.com", APP_ALIASES: "factory.example.com" }, "factory.example.com"],
      [{ APP_DOMAIN: "example.com", APP_ALIASES: "example.com=/a" }, "example.com=/a"],
      [
        { APP_DOMAIN: "example.com", APP_DOMAIN_REDIRECTS: "www.example.com", APP_ALIASES: "www.example.com=/a" },
        "www.example.com=/a",
      ],
      [{ APP_DOMAIN: WORKERS_DEV, APP_ALIASES: "factory.example.com=/a" }, "factory.example.com=/a"],
      // Read before APP_DOMAIN, so an invalid list is named even when APP_DOMAIN is unset.
      [{ APP_ALIASES: "factory.example.com=x" }, "factory.example.com=x"],
    ] as const) {
      const error = aliasRefusal(env)
      expect(error.value).toBe(value)
      expect(error.message).toBe(
        `APP_ALIASES lists "${value}": each entry must be host=/path, such as factory.example.com=/acme/app, with a ` +
          "hostname other than APP_DOMAIN and its redirects, and APP_DOMAIN must name a domain, not workers.dev " +
          "(docs/infrastructure.md#domain).",
      )
    }
  })

  test("reach Alchemy as the domain's aliases, and the site Worker as their text", () => {
    const host = { name: "example.com", redirects: [], aliases: [factory, { host: "b.example.com", path: "/app" }] }
    expect(workerDomain(host)).toEqual({ name: "example.com", aliases: ["factory.example.com", "b.example.com"] })
    expect(workerDomain({ ...host, redirects: ["www.example.com"] })).toEqual({
      name: "example.com",
      aliases: ["factory.example.com", "b.example.com"],
      redirects: ["www.example.com"],
    })
    expect(aliasesBinding(host)).toBe("factory.example.com=/acme/widgets/-/factory,b.example.com=/app")
  })
})

describe("the docs site's routes", () => {
  test("claim each of its paths on the domain, and only those", () => {
    const routes = docsRoutes("example.com")
    expect(routes).toContainEqual({ pattern: "example.com/docs" })
    expect(routes).toContainEqual({ pattern: "example.com/docs/*" })
    expect(routes).toContainEqual({ pattern: "example.com/llms.txt*" })
    for (const { pattern } of routes) {
      // Cloudflare takes `*` only at a route path's end, and refuses a query in one.
      expect(pattern).toMatch(/^example\.com\/[^*?]*\*?$/)
      expect(DOCS_SITE.test(pattern.slice("example.com".length).replace(/\*$/, ""))).toBe(true)
    }
    expect(new Set(routes.map(({ pattern }) => pattern)).size).toBe(routes.length)
  })
})
