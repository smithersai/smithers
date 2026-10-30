// Hostnames beside the app's domain that open one page of the app, `APP_ALIASES` (docs/infrastructure.md#domain), such
// as `factory.example.com=/acme/widgets/-/factory`. Each is another custom domain of the site Worker: `/` there
// redirects to its page, and every other path is the app. infra/Domain.ts reads the list when it deploys and the site
// Worker (worker/index.ts) reads the same text at run time, so both parse it here.

/** One alias: the hostname, and the app's page its `/` opens. */
export interface Alias {
  readonly host: string
  readonly path: string
}

/** A lowercase DNS name with at least two labels, such as `example.com` or `app.example.com`. */
export const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** A path on the app's own origin: one leading slash, no query, fragment, backslash or space. */
const PAGE = /^\/(?![/\\])[^\s?#\\]{0,511}$/

/**
 * The aliases `value` lists, comma-separated `host=path` entries, blank entries skipped; or the first entry that
 * isn't one, as `{ invalid }`. A hostname listed twice is invalid at its second entry.
 */
export const parseAliases = (value: string): ReadonlyArray<Alias> | { readonly invalid: string } => {
  const aliases: Array<Alias> = []
  for (const raw of value.split(",")) {
    const entry = raw.trim()
    if (entry === "") continue
    const at = entry.indexOf("=")
    const host = entry.slice(0, at).trim()
    const path = entry.slice(at + 1).trim()
    if (at < 0 || !HOSTNAME.test(host) || !PAGE.test(path) || aliases.some((alias) => alias.host === host)) {
      return { invalid: entry }
    }
    aliases.push({ host, path })
  }
  return aliases
}

/**
 * Where a request for `url` goes instead, when `url` is `/` on one of the aliases `listed` names: the alias's page on
 * the same origin, the query kept. `undefined` for every other request, and for a list that doesn't parse, which the
 * deploy already refused.
 */
export const aliasLocation = (listed: string | undefined, url: URL): string | undefined => {
  if (listed === undefined || url.pathname !== "/") return undefined
  const aliases = parseAliases(listed)
  if ("invalid" in aliases) return undefined
  const alias = aliases.find((entry) => entry.host === url.hostname)
  return alias === undefined ? undefined : `${url.origin}${alias.path}${url.search}`
}
