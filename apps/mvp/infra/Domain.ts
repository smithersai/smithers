// The hostname a production deployment serves the app at, `APP_DOMAIN`. The deployment supplies it with its other
// identifiers; the public stack names no domain of its own (docs/infrastructure.md#domain).
import { Config, Data, Effect, Option } from "effect"
import { DOCS_SITE_PATHS } from "../src/pwa.ts"
import { type Alias, HOSTNAME, parseAliases } from "../worker/aliases.ts"

/** `APP_DOMAIN`'s value for a deployment served only at its `workers.dev` URL, with no custom domain and no docs site. */
export const WORKERS_DEV = "workers.dev"

/**
 * A production deploy without a usable `APP_DOMAIN`. Unset is refused rather than read as "no domain": a deploy that
 * dropped it would detach the hostname's docs site, so the choice is spelled out every time.
 */
export class AppDomainInvalid extends Data.TaggedError("AppDomainInvalid")<{ readonly value: string | undefined }> {
  override get message() {
    return this.value === undefined
      ? `APP_DOMAIN is unset. Set it to the hostname the app serves at, such as example.com, or to ${WORKERS_DEV} ` +
          "to serve it only at its workers.dev URL (docs/infrastructure.md#domain)."
      : `APP_DOMAIN is "${this.value}": it must be a hostname such as example.com, with no scheme, port or path, ` +
          `or ${WORKERS_DEV} (docs/infrastructure.md#domain).`
  }
}

/** An `APP_DOMAIN_REDIRECTS` entry that isn't a hostname, is `APP_DOMAIN` itself, or has no domain to go to. */
export class AppDomainRedirectInvalid extends Data.TaggedError("AppDomainRedirectInvalid")<{ readonly value: string }> {
  override get message() {
    return `APP_DOMAIN_REDIRECTS lists "${this.value}": each entry must be a hostname such as www.example.com, other ` +
      `than APP_DOMAIN, and APP_DOMAIN must name a domain, not ${WORKERS_DEV} (docs/infrastructure.md#domain).`
  }
}

/**
 * An `APP_ALIASES` entry that isn't `host=/path`, names a hostname twice or one `APP_DOMAIN` or its redirects already
 * use, or has no domain to sit beside.
 */
export class AppAliasInvalid extends Data.TaggedError("AppAliasInvalid")<{ readonly value: string }> {
  override get message() {
    return `APP_ALIASES lists "${this.value}": each entry must be host=/path, such as factory.example.com=/acme/app, ` +
      "with a hostname other than APP_DOMAIN and its redirects, and APP_DOMAIN must name a domain, not " +
      `${WORKERS_DEV} (docs/infrastructure.md#domain).`
  }
}

/**
 * The app's custom domain: the hostname it serves at, the hostnames that redirect there, and the aliases, other
 * hostnames that serve the app and open one page of it at `/`.
 */
export interface AppHost {
  readonly name: string
  readonly redirects: ReadonlyArray<string>
  readonly aliases: ReadonlyArray<Alias>
}

/**
 * The custom domain a production deploy attaches the app to: `APP_DOMAIN`, or none when it is `workers.dev`, with the
 * comma-separated hostnames of `APP_DOMAIN_REDIRECTS`, which answer with a 301 to it. Fails with
 * {@link AppDomainInvalid} when `APP_DOMAIN` is unset or isn't a hostname, and {@link AppDomainRedirectInvalid} for a
 * redirect that can't be one.
 */
export const AppDomain: Effect.Effect<
  Option.Option<AppHost>,
  AppDomainInvalid | AppDomainRedirectInvalid | AppAliasInvalid | Config.ConfigError
> = Effect.gen(function* () {
  const value = yield* Config.option(Config.String("APP_DOMAIN"))
  const listed = yield* Config.option(Config.String("APP_DOMAIN_REDIRECTS"))
  const aliases = parseAliases(Option.getOrElse(yield* Config.option(Config.String("APP_ALIASES")), () => ""))
  if ("invalid" in aliases) return yield* new AppAliasInvalid({ value: aliases.invalid })
  const redirects = Option.match(listed, {
    onNone: () => [],
    onSome: (list) => list.split(",").map((entry) => entry.trim()).filter((entry) => entry !== ""),
  })
  if (Option.isNone(value)) return yield* new AppDomainInvalid({ value: undefined })
  if (value.value === WORKERS_DEV) {
    if (redirects.length > 0) return yield* new AppDomainRedirectInvalid({ value: redirects[0]! })
    if (aliases.length > 0) return yield* new AppAliasInvalid({ value: `${aliases[0]!.host}=${aliases[0]!.path}` })
    return Option.none()
  }
  if (!HOSTNAME.test(value.value)) return yield* new AppDomainInvalid({ value: value.value })
  const wrong = redirects.find((entry) => !HOSTNAME.test(entry) || entry === value.value)
  if (wrong !== undefined) return yield* new AppDomainRedirectInvalid({ value: wrong })
  const taken = aliases.find((alias) => alias.host === value.value || redirects.some((entry) => entry === alias.host))
  if (taken !== undefined) return yield* new AppAliasInvalid({ value: `${taken.host}=${taken.path}` })
  return Option.some({ name: value.value, redirects, aliases })
})

/**
 * The site Worker's `domain` for Alchemy: the bare hostname without redirects or aliases, so a deployment with no
 * redirect never needs the zone's redirect rules, which Alchemy writes for each one. Each alias is another custom
 * domain of the same Worker.
 */
export const workerDomain = (host: AppHost) =>
  host.redirects.length === 0 && host.aliases.length === 0
    ? host.name
    : {
      name: host.name,
      ...(host.aliases.length === 0 ? {} : { aliases: host.aliases.map((alias) => alias.host) }),
      ...(host.redirects.length === 0 ? {} : { redirects: [...host.redirects] }),
    }

/** The site Worker's `APP_ALIASES` binding: the aliases' text, which it reads at run time (worker/aliases.ts). */
export const aliasesBinding = (host: AppHost) => host.aliases.map((alias) => `${alias.host}=${alias.path}`).join(",")

/**
 * The docs site's zone routes on `domain`, one for each path it serves there (infra/DocsSite.ts). Cloudflare runs a
 * route before the domain's Worker, so these paths are the docs site's and every other one stays the app's.
 */
export const docsRoutes = (domain: string) => DOCS_SITE_PATHS.map((path) => ({ pattern: `${domain}${path}` }))
