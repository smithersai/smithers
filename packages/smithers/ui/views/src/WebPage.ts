/**
 * Whether an outside web page shows in a frame, and what a card shows
 * instead, read by a server before the page is framed.
 *
 * A browser never tells a page why a frame it holds stays blank: a page that
 * refuses framing with `X-Frame-Options` or a Content Security Policy
 * `frame-ancestors` shows an error the framing page cannot read. So a host
 * asks first, from a server. {@link check} requests the page as a frame would
 * and answers whether the browser would show it to the given ancestors
 * ({@link framing}, {@link content}), with a {@link preview} read from the
 * page's head: its title, description and icon, for a card in its place.
 *
 * The request is a server-side fetch of a URL someone else chose, so it is
 * guarded on every hop:
 *
 * - `https:` or `http:` only, with no user or password;
 * - named hosts only: an IP address literal, `localhost`, a single-label name
 *   or a local suffix (`.localhost`, `.local`, `.internal`, `.home.arpa`,
 *   `.lan`) is never requested unless `privateHosts` names it;
 * - at most `maxRedirects` redirects, each guarded again;
 * - one deadline for the response, and a shorter one for reading the head;
 * - at most `maxBytes` of an HTML body, stopping at `</head>`, and nothing of
 *   any other body;
 * - no cookies, no credentials and no trace context.
 *
 * A public name whose DNS answer is a private address is refused by the
 * platform's egress, not here: run the check where egress is mediated, such
 * as a Cloudflare Worker, whose fetch reaches public addresses only.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Base64 from "effect/encoding/Base64"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { refusal } from "./internal/hosts.ts"

/**
 * What a browser would do with the page in a frame: show it (`allowed`),
 * refuse it (`refused`), or nobody can say (`unknown`), because the page
 * could not be read or answered with an error.
 *
 * @category models
 * @since 0.1.0
 */
export const FRAMINGS = ["allowed", "refused", "unknown"] as const

/**
 * One of {@link FRAMINGS}.
 *
 * @category models
 * @since 0.1.0
 */
export type Framing = (typeof FRAMINGS)[number]

/**
 * Why a page is not `allowed`:
 *
 * - `x_frame_options`, `frame_ancestors`: the page refuses framing by these
 *   ancestors;
 * - `insecure`: the page ends on `http:` under an `https:` ancestor, which
 *   browsers block as mixed content;
 * - `content`: the frame can't show the response: a PDF, a download, or an
 *   attachment;
 * - `status`: the page answered 400 or above;
 * - `invalid_url`: not an absolute `https:` or `http:` URL without a user or
 *   password;
 * - `private_host`: a host the check never requests;
 * - `redirects`: too many redirects, or one to a URL the check won't follow;
 * - `timeout`: no response within the deadline;
 * - `unreachable`: the request failed.
 *
 * @category models
 * @since 0.1.0
 */
export const REASONS = [
  "x_frame_options",
  "frame_ancestors",
  "insecure",
  "content",
  "status",
  "invalid_url",
  "private_host",
  "redirects",
  "timeout",
  "unreachable"
] as const

/**
 * One of {@link REASONS}.
 *
 * @category models
 * @since 0.1.0
 */
export type Reason = (typeof REASONS)[number]

/**
 * The longest title a preview keeps, in UTF-16 code units.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_TITLE = 200

/**
 * The longest description a preview keeps, in UTF-16 code units.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_DESCRIPTION = 300

/**
 * The longest icon URL a preview keeps, in UTF-16 code units.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_ICON_URL = 2_048

const MAX_ICON_BYTES = 64 * 1024
/**
 * The maximum length of a host-fetched inline icon, including its data URL prefix.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_ICON_DATA_URL = 4 * Math.ceil(MAX_ICON_BYTES / 3) + 100

/**
 * What a card shows for a page, read from its head: its title, a short
 * description and an icon. The pure parser returns its `https:` URL;
 * `check` fetches a bounded image and returns a `data:image/…` URL, or omits
 * the icon when it cannot be safely read.
 *
 * @category models
 * @since 0.1.0
 */
export const Preview = Schema.Struct({
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_TITLE))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_DESCRIPTION))),
  icon: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_ICON_DATA_URL)))
})

/**
 * A {@link Preview}.
 *
 * @category models
 * @since 0.1.0
 */
export type Preview = typeof Preview.Type

/**
 * A page's answer: its {@link Framing}, the {@link Reason} when it isn't
 * `allowed`, the final response's status when there was one, and its
 * {@link Preview}.
 *
 * @category models
 * @since 0.1.0
 */
export const Checked = Schema.Struct({
  framing: Schema.Literals(FRAMINGS),
  reason: Schema.optional(Schema.Literals(REASONS)),
  status: Schema.optional(Schema.Number),
  ...Preview.fields
})

/**
 * A {@link Checked}.
 *
 * @category models
 * @since 0.1.0
 */
export type Checked = typeof Checked.Type

/**
 * Response headers by name, in any case, as Effect's `Headers` or a plain
 * record holds them.
 *
 * @category models
 * @since 0.1.0
 */
export type HeaderRecord = Readonly<Record<string, string | undefined>>

const header = (headers: HeaderRecord, name: string): string | undefined => {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value
  return undefined
}

/** An ancestor's port, its scheme's default when the URL leaves it out; ancestors are `http:` or `https:`. */
const portOf = (url: URL): string => url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80"

/**
 * CSP3's scheme-part match: a scheme matches itself, and an insecure scheme
 * also matches its secure upgrade.
 */
const schemeMatches = (expression: string, actual: string): boolean =>
  expression === actual ||
  (expression === "http:" && actual === "https:") ||
  (expression === "ws:" && (actual === "wss:" || actual === "http:" || actual === "https:")) ||
  (expression === "wss:" && actual === "https:")

/** `[scheme://]host[:port][/path]`, with `*` or a leading `*.` in the host and `*` as the port. */
const HOST_SOURCE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\*|\d+))?(\/[^?#]*)?$/

/** Whether `ancestor`'s origin matches one source expression of a `frame-ancestors` list protecting `page`. */
const sourceMatches = (expression: string, ancestor: URL, page: URL): boolean => {
  const source = expression.toLowerCase()
  if (source === "*") return ancestor.protocol === "http:" || ancestor.protocol === "https:"
  if (source === "'self'") return ancestor.origin === page.origin
  if (/^[a-z][a-z0-9+.-]*:$/.test(source)) return schemeMatches(source, ancestor.protocol)
  const parts = HOST_SOURCE.exec(source)
  if (parts === null) return false
  const [, scheme, host, port, path] = parts
  if (!schemeMatches(scheme === undefined ? page.protocol : `${scheme}:`, ancestor.protocol)) return false
  const hostname = ancestor.hostname.toLowerCase()
  if (host!.startsWith("*.") ? !hostname.endsWith(host!.slice(1)) : host !== "*" && host !== hostname) return false
  // An ancestor's URL is its origin, whose path is `/`.
  if (path !== undefined && path !== "/") return false
  if (port === "*") return true
  if (port === undefined) return ancestor.port === ""
  return port === portOf(ancestor) || (port === "80" && ancestor.protocol === "https:" && portOf(ancestor) === "443")
}

/**
 * The source lists of every enforced policy's first `frame-ancestors`
 * directive. Repeated headers arrive joined by commas, and one header may
 * carry several comma-separated policies; each applies on its own.
 */
const frameAncestors = (headers: HeaderRecord): Array<Array<string>> => {
  const lists: Array<Array<string>> = []
  for (const policy of (header(headers, "content-security-policy") ?? "").split(",")) {
    const seen = new Set<string>()
    for (const directive of policy.split(";")) {
      const [name, ...sources] = directive.trim().split(/[\t\n\f\r ]+/)
      const directiveName = name!.toLowerCase()
      if (directiveName === "" || seen.has(directiveName)) continue
      seen.add(directiveName)
      if (directiveName === "frame-ancestors") lists.push(sources)
    }
  }
  return lists
}

/**
 * Whether a browser frames the page that answered with `headers` when
 * `ancestors` (the framing page's origin, then each origin above it) hold the
 * frame, as the browser's navigation checks decide:
 *
 * - an `http:` page under an `https:` ancestor is mixed content, unless it is
 *   on this machine (`localhost`, `127.0.0.0/8`, `[::1]`);
 * - every enforced `Content-Security-Policy` with a `frame-ancestors`
 *   directive must match every ancestor, and when any has one,
 *   `X-Frame-Options` is ignored;
 * - otherwise `X-Frame-Options: DENY` refuses, `SAMEORIGIN` refuses unless
 *   every ancestor is the page's origin, and conflicting values refuse.
 *
 * A report-only policy, and a policy in a `<meta>` element, never refuse
 * framing, so neither is read. Invalid page or ancestor URLs, or an empty
 * ancestor list, return `unknown` with reason `invalid_url`.
 *
 * @category framing
 * @since 0.1.0
 */
export const framing = (
  headers: HeaderRecord,
  frame: { readonly page: string; readonly ancestors: ReadonlyArray<string> }
): { readonly framing: "allowed" } | {
  readonly framing: "refused"
  readonly reason: "x_frame_options" | "frame_ancestors" | "insecure"
} | { readonly framing: "unknown"; readonly reason: "invalid_url" } => {
  const page = URL.parse(frame.page)
  const ancestors: Array<URL> = []
  if (page === null || frame.ancestors.length === 0) return { framing: "unknown", reason: "invalid_url" }
  for (const value of frame.ancestors) {
    const ancestor = URL.parse(value)
    if (ancestor === null) return { framing: "unknown", reason: "invalid_url" }
    ancestors.push(ancestor)
  }
  if (
    page.protocol === "http:" && !onThisMachine(page) && ancestors.some((ancestor) => ancestor.protocol === "https:")
  ) {
    return { framing: "refused", reason: "insecure" }
  }
  const lists = frameAncestors(headers)
  if (lists.length > 0) {
    const admitted = lists.every((sources) =>
      ancestors.every((ancestor) => sources.some((source) => sourceMatches(source, ancestor, page)))
    )
    return admitted ? { framing: "allowed" } : { framing: "refused", reason: "frame_ancestors" }
  }
  const options = header(headers, "x-frame-options")
  if (options === undefined) return { framing: "allowed" }
  const values = new Set(options.split(",").map((value) => value.trim().toLowerCase()))
  const refused = values.size > 1
    ? values.has("deny") || values.has("sameorigin") || values.has("allowall")
    : values.has("deny") || (values.has("sameorigin") && ancestors.some((ancestor) => ancestor.origin !== page.origin))
  return refused ? { framing: "refused", reason: "x_frame_options" } : { framing: "allowed" }
}

/** Whether `url` is on this machine, which browsers trust over `http:` (a potentially trustworthy origin). */
const onThisMachine = (url: URL): boolean =>
  url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "[::1]" ||
  /^127\.\d+\.\d+\.\d+$/.test(url.hostname)

/** Media types a sandboxed frame never shows: PDF viewers refuse to run sandboxed, and a download needs a permission the frame lacks. */
const UNSHOWN_TYPES: ReadonlySet<string> = new Set(["application/pdf", "application/octet-stream"])

/**
 * Whether a sandboxed frame without `allow-downloads` can show the response
 * that answered with `headers`: not an attachment, a PDF or an octet stream.
 *
 * @category framing
 * @since 0.1.0
 */
export const content = (headers: HeaderRecord): boolean => {
  const disposition = header(headers, "content-disposition")?.split(";")[0]!.trim().toLowerCase()
  return disposition !== "attachment" && !UNSHOWN_TYPES.has(mediaType(headers))
}

const mediaType = (headers: HeaderRecord): string =>
  (header(headers, "content-type") ?? "").split(";")[0]!.trim().toLowerCase()

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }

/** One pass, so `&amp;lt;` stays the text `&lt;`. */
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gi, (match, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? match
    const hex = entity[1] === "x" || entity[1] === "X"
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : match
  })

/** Whitespace collapsed, at most `max` UTF-16 code units, cut between code points with an ellipsis; nothing when empty. */
const clean = (text: string | undefined, max: number): string | undefined => {
  if (text === undefined) return undefined
  const collapsed = decodeEntities(text).replace(/\s+/g, " ").trim()
  if (collapsed.length === 0) return undefined
  if (collapsed.length <= max) return collapsed
  let kept = ""
  for (const point of collapsed) {
    if (kept.length + point.length > max - 1) break
    kept += point
  }
  return `${kept.trimEnd()}…`
}

/** One tag's attributes, names lowercased, values decoded; a repeated name keeps its first value. */
const attributesOf = (source: string): Map<string, string> => {
  const attributes = new Map<string, string>()
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!.toLowerCase()
    if (!attributes.has(name)) attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""))
  }
  return attributes
}

/** Elements whose contents are not markup: skipped whole, so a `<meta>` inside a script is never read. */
const RAW_TEXT = new Set(["script", "style", "noscript", "template", "textarea", "xmp"])

/**
 * A `<link rel>` that names an icon a card may show: `icon` (with or without
 * `shortcut`) first, then `apple-touch-icon`. A mask icon is a monochrome
 * outline, so it is not one.
 */
const iconRank = (rel: string): number => {
  const tokens = rel.toLowerCase().split(/\s+/)
  return tokens.includes("icon") ? 2 : tokens.includes("apple-touch-icon") ? 1 : 0
}

/** The `https:` URL `href` names against `base`, or nothing. */
const iconUrl = (href: string, base: URL): string | undefined => {
  const url = URL.parse(href.trim(), base)
  if (url === null || url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined
  return url.href.length <= MAX_ICON_URL ? url.href : undefined
}

/**
 * A card's {@link Preview} from a page's HTML, as `pageUrl` served it. Only
 * the head is read: elements up to `</head>` or `<body>`, skipping comments
 * and the contents of scripts, styles and templates.
 *
 * - The title is `og:title`, else `<title>`.
 * - The description is `og:description`, else `description`, else
 *   `twitter:description`.
 * - The icon is the first `rel="icon"` link, else the first
 *   `apple-touch-icon`, resolved against `<base href>` or the page; an
 *   `https:` page with neither has `/favicon.ico`. Only an `https:` icon is
 *   kept.
 *
 * Text is decoded, whitespace collapsed, and cut to {@link MAX_TITLE} and
 * {@link MAX_DESCRIPTION} UTF-16 code units without splitting a code point.
 * The scan is linear in the input.
 *
 * @category previews
 * @since 0.1.0
 */
export const preview = (html: string, pageUrl: string): Preview => {
  const page = new URL(pageUrl)
  const meta = new Map<string, string>()
  let title: string | undefined
  let base = page
  let icon: { readonly href: string; readonly rank: number } | undefined
  let cursor = 0
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor)
    if (open === -1) break
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4)
      if (end === -1) break
      cursor = end + 3
      continue
    }
    const name = /^<\/?([a-z][a-z0-9-]*)/i.exec(html.slice(open, open + 32))?.[1]?.toLowerCase()
    if (name === undefined) {
      cursor = open + 1
      continue
    }
    // Every scan for `>` starts past the last one, so the whole pass stays linear.
    const close = html.indexOf(">", open + 1)
    if (close === -1) break
    if (html[open + 1] === "/" ? name === "head" : name === "body") break
    cursor = close + 1
    if (html[open + 1] === "/") continue
    if (name === "title" || RAW_TEXT.has(name)) {
      const closing = new RegExp(`</${name}`, "gi")
      closing.lastIndex = cursor
      const end = closing.exec(html)?.index ?? -1
      if (name === "title") title ??= html.slice(cursor, end === -1 ? html.length : end)
      if (end === -1) break
      cursor = end
      continue
    }
    const attributes = attributesOf(html.slice(open + 1 + name.length, close))
    if (name === "meta") {
      const key = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase()
      const value = attributes.get("content")
      if (key !== undefined && value !== undefined && !meta.has(key)) meta.set(key, value)
    } else if (name === "base") {
      base = URL.parse(attributes.get("href") ?? "", page) ?? base
    } else if (name === "link") {
      const rank = iconRank(attributes.get("rel") ?? "")
      const href = attributes.get("href")
      if (rank > (icon?.rank ?? 0) && href !== undefined) icon = { href, rank }
    }
  }
  const iconHref = icon === undefined ? undefined : iconUrl(icon.href, base)
  const found = {
    title: clean(meta.get("og:title") ?? title, MAX_TITLE),
    description: clean(
      meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description"),
      MAX_DESCRIPTION
    ),
    icon: iconHref ?? (page.protocol === "https:" ? `${page.origin}/favicon.ico` : undefined)
  }
  return Object.fromEntries(Object.entries(found).filter(([, value]) => value !== undefined))
}

/**
 * How {@link check} requests a page.
 *
 * - `ancestors`: the origins that will hold the frame, the framing page's
 *   first.
 * - `privateHosts`: hostnames the guard would refuse that the check may read
 *   anyway, such as `localhost` and `127.0.0.1` in development. Exact, as a
 *   URL's `hostname` spells them (`[::1]`).
 * - `maxRedirects`: redirects followed. Default 5.
 * - `timeout`: the deadline for the final response's headers, every redirect
 *   included. Default 8 seconds.
 * - `headTimeout`: the deadline for reading the head after that. Default 3
 *   seconds; past it, the preview is what arrived.
 * - `maxBytes`: the most of an HTML body read. Default 256 KiB.
 * - `userAgent`: the `User-Agent` sent. Default `Mozilla/5.0 (compatible;
 *   web-page-check)`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly ancestors: ReadonlyArray<string>
  readonly privateHosts?: ReadonlyArray<string> | undefined
  readonly maxRedirects?: number | undefined
  readonly timeout?: Duration.Input | undefined
  readonly headTimeout?: Duration.Input | undefined
  readonly maxBytes?: number | undefined
  readonly userAgent?: string | undefined
}

const unknown = (reason: Reason, status?: number): Checked =>
  status === undefined ? { framing: "unknown", reason } : { framing: "unknown", reason, status }

/** A decoder for the charset `type` names, when the platform's `TextDecoder` reads it, else UTF-8. */
const decoderFor = (type: string): TextDecoder => {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1]
  try {
    return new TextDecoder(charset ?? "utf-8")
  } catch {
    return new TextDecoder("utf-8")
  }
}

/**
 * The body's text up to `</head>` or `maxBytes`, whichever comes first, read
 * for at most `within`: what arrived by then when the deadline passes or the
 * stream fails. Only an HTML response, which names its type, is read.
 */
const readHead = (response: HttpClientResponse.HttpClientResponse, maxBytes: number, within: Duration.Input) =>
  Effect.suspend(() => {
    const decoder = decoderFor(header(response.headers, "content-type")!)
    let text = ""
    let bytes = 0
    return Stream.runForEachWhile(response.stream, (chunk) =>
      Effect.sync(() => {
        const kept = chunk.subarray(0, maxBytes - bytes)
        bytes += kept.byteLength
        text += decoder.decode(kept, { stream: true })
        return bytes < maxBytes && !/<\/head\s*>/i.test(text.slice(-(kept.byteLength + 16)))
      })).pipe(Effect.timeoutOption(within), Effect.ignore, Effect.map(() => text))
  })

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/** Where following a URL's redirects ends: a page's response, or the check's answer without one. */
type Answer =
  | { readonly checked: Checked }
  | { readonly response: HttpClientResponse.HttpClientResponse; readonly page: URL; readonly hop: number }

/**
 * Requests `url` as a frame would, guarded as the module describes, and
 * answers how a browser would treat it in a frame held by
 * `options.ancestors`, with the page's {@link Preview} when it is HTML.
 *
 * It never fails: a URL it won't request, a request that fails or times out,
 * too many redirects and an error status are each `unknown` with a
 * {@link Reason}. Redirects are followed by the check, not the client, so the
 * client must leave a `3xx` to its caller: Effect's `FetchHttpClient` does,
 * with the `redirect: "manual"` the check provides.
 *
 * The span `WebPage.check` carries the framing, the reason, the status and
 * the redirects followed, never the URL. The requests record no client span,
 * which would carry the URL, and send the page no trace context.
 *
 * @category checking
 * @since 0.1.0
 */
export const check = (url: string, options: Options): Effect.Effect<Checked, never, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const init = Option.getOrElse(yield* Effect.serviceOption(FetchHttpClient.RequestInit), () => ({}))
    const privateHosts = (options.privateHosts ?? []).map((host) => host.toLowerCase())
    const maxRedirects = options.maxRedirects ?? 5
    const request = (href: string, image = false) =>
      client.execute(HttpClientRequest.get(href, {
        headers: {
          accept: image ? "image/*" : "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "sec-fetch-dest": image ? "image" : "iframe",
          "sec-fetch-mode": image ? "no-cors" : "navigate",
          "sec-fetch-site": "cross-site",
          "user-agent": options.userAgent ?? "Mozilla/5.0 (compatible; web-page-check)"
        }
      })).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { ...init, redirect: "manual" }),
        // The URL is someone else's content: no client span records it, and no trace context goes to the page.
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false)
      )

    /** Requests `current`, guarded, and follows its redirects to the page it ends on, or why it can't. */
    const follow = (current: URL, hop: number, image = false): Effect.Effect<Answer, never, HttpClient.HttpClient> =>
      Effect.gen(function*() {
        const refused = refusal(current, privateHosts)
        if (refused !== undefined) {
          return { checked: unknown(hop > 0 && refused === "invalid_url" ? "redirects" : refused) }
        }
        const answered = yield* Effect.result(request(current.href, image))
        if (answered._tag === "Failure") return { checked: unknown("unreachable") }
        const response = answered.success
        const location = header(response.headers, "location")
        if (!REDIRECTS.has(response.status) || location === undefined) return { response, page: current, hop }
        const next = URL.parse(location, current)
        if (hop === maxRedirects || next === null) return { checked: unknown("redirects", response.status) }
        return yield* follow(next, hop + 1, image)
      })

    const start = URL.parse(url)
    const respond = start === null ?
      Effect.succeed<Answer>({ checked: unknown("invalid_url") }) :
      follow(start, 0).pipe(
        Effect.timeoutOrElse({
          duration: options.timeout ?? "8 seconds",
          orElse: () => Effect.succeed<Answer>({ checked: unknown("timeout") })
        })
      )

    const answer = yield* respond
    if ("checked" in answer) return answer.checked
    const { response, page, hop } = answer
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status, "web_page.redirects": hop })
    const html = /^(text\/html|application\/xhtml\+xml)$/.test(mediaType(response.headers))
    const head = html
      ? yield* readHead(response, options.maxBytes ?? 256 * 1024, options.headTimeout ?? "3 seconds")
      : ""
    const found = html ? preview(head, page.href) : {}
    const { icon: remoteIcon, ...text } = found
    const icon = remoteIcon === undefined ? undefined : yield* Effect.gen(function*() {
      const result = yield* follow(new URL(remoteIcon), 0, true)
      if ("checked" in result || result.response.status >= 300) return undefined
      const type = mediaType(result.response.headers)
      if (!/^image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/.test(type)) return undefined
      let length = 0
      const chunks: Array<Uint8Array> = []
      yield* Stream.runForEachWhile(result.response.stream, (chunk) =>
        Effect.sync(() => {
          length += chunk.byteLength
          if (length > MAX_ICON_BYTES) return false
          chunks.push(chunk)
          return true
        }))
      if (length === 0 || length > MAX_ICON_BYTES) return undefined
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return `data:${type};base64,${Base64.encode(bytes)}`
    }).pipe(
      Effect.timeoutOption(options.headTimeout ?? "3 seconds"),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
      Effect.map(Option.getOrUndefined)
    )
    yield* Effect.annotateCurrentSpan({
      "web_page.icon": remoteIcon === undefined ? "absent" : icon === undefined ? "unavailable" : "inline"
    })
    const shown = { ...text, ...(icon === undefined ? {} : { icon }), status: response.status }
    const framed = framing(response.headers, { page: page.href, ancestors: options.ancestors })
    if (framed.framing !== "allowed") return { ...shown, ...framed }
    if (!content(response.headers)) return { ...shown, framing: "refused", reason: "content" } as const
    if (response.status >= 400) return { ...shown, framing: "unknown", reason: "status" } as const
    return { ...shown, framing: "allowed" } as const
  }).pipe(
    Effect.tap((checked) =>
      Effect.annotateCurrentSpan({
        "web_page.framing": checked.framing,
        ...(checked.reason === undefined ? {} : { "web_page.reason": checked.reason })
      })
    ),
    Effect.withSpan("WebPage.check")
  )
