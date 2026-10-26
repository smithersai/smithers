import { MAX_URL_LENGTH, type WebMode } from "./contract"

// Which outside pages `app/web/open` opens (docs/features/web-pages.md#which-pages). Every side checks with this: the
// flow's step, a person's `/web` before it opens a tab, and ChatApi before it keeps a view. Refusals name a reason a
// person or the agent can act on, never the URL. Nothing here imports a library, so every side can.
//
// - Only `https:`, or `http:` on this machine (`localhost`) for a new tab while the app runs in development. Never
//   `javascript:`, `data:`, `file:`, `blob:` or any other scheme, and never a URL that names a user or a password.
// - Never the app's own host: a page of the app opens with `app/navigate`.
// - `embed` frames the page with `allow-scripts allow-same-origin` (`@smthrs/ui`'s `WebPageView`). A framed page that
//   is same-origin with the app could remove its own sandbox and reach the app's storage, session and DOM, and one
//   that is same-site shares its cookies. So `embed` takes only `https:` pages of another site: never `http:`, even on
//   this machine (cookies aren't kept apart by port), and never the app's own site or its subdomains. A redirect
//   inside the frame can't be inspected, so the app's own pages refuse to be framed at all (`frame-ancestors 'none'`).

/** Why a URL isn't opened. */
export const REFUSALS = ["invalid", "scheme", "insecure", "credentials", "same_origin", "same_site"] as const

/**
 * One of {@link REFUSALS}:
 * - `invalid`: not an absolute URL, longer than `MAX_URL_LENGTH`, or an unusable application origin;
 * - `scheme`: not `https:` or `http:`, such as `javascript:`, `data:`, `file:` or `blob:`;
 * - `insecure`: `http:`, which only a new tab on `localhost` in development takes;
 * - `credentials`: it names a user or a password;
 * - `same_origin`: it is the app's own host, which `app/navigate` opens instead;
 * - `same_site`: `embed` of a page that shares the app's cookies: its site, or a subdomain of it.
 */
export type Refusal = (typeof REFUSALS)[number]

/** Who checks: whether `http:` on this machine opens in a new tab (development only), and the app's own origin. */
export interface Policy {
  readonly localHttp: boolean
  readonly appOrigin: string
}

/** A URL the policy allows: its normalized form, and the origin a person is shown. */
export interface Allowed {
  readonly href: string
  readonly origin: string
}

/** The policy's answer. */
export type Checked = { readonly ok: true; readonly page: Allowed } | { readonly ok: false; readonly reason: Refusal }

/** This machine's hostnames, as a URL spells them: what `localHttp` lets a tab open and ChatApi's page check read. */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Browsers drop ASCII tab, line feed and carriage return before they parse a URL; so does the check. */
const CONTROL = /[\t\n\r]/g

/** Parses `input` as an absolute URL, as a browser would, or nothing. */
const parse = (input: string): URL | undefined => {
  try {
    return new URL(input.replace(CONTROL, "").trim())
    // expected: input that isn't a URL parses to nothing
  } catch {
    return undefined
  }
}

/**
 * The site a hostname's cookies are shared across: itself for an IP address or a single label such as `localhost`,
 * else its last two labels. Under a public suffix of two labels (`pages.dev`, `co.uk`) that is wider than the real
 * site, so `embed` refuses more than it must, never less.
 */
export const siteOf = (hostname: string): string => {
  if (hostname.startsWith("[") || /^\d+(\.\d+){3}$/.test(hostname)) return hostname
  return hostname.split(".").slice(-2).join(".")
}

/** Whether `hostname` is `site` or one of its subdomains. */
const within = (hostname: string, site: string): boolean => hostname === site || hostname.endsWith(`.${site}`)

/** Checks `input`, opened as `mode`, against `policy`: the page to open, or why not. */
export const checkUrl = (input: string, mode: WebMode, policy: Policy): Checked => {
  if (input.length > MAX_URL_LENGTH) return { ok: false, reason: "invalid" }
  const url = parse(input)
  if (url === undefined) return { ok: false, reason: "invalid" }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "scheme" }
  if (url.protocol === "http:" && !(mode === "tab" && policy.localHttp && LOCAL_HOSTS.has(url.hostname))) {
    return { ok: false, reason: "insecure" }
  }
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" }
  const app = parse(policy.appOrigin)
  if (app === undefined || (app.protocol !== "https:" && app.protocol !== "http:")) {
    return { ok: false, reason: "invalid" }
  }
  if (url.host === app.host) return { ok: false, reason: "same_origin" }
  if (mode === "embed" && within(url.hostname, siteOf(app.hostname))) {
    return { ok: false, reason: "same_site" }
  }
  return { ok: true, page: { href: url.href, origin: url.origin } }
}
