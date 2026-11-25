// The outside web as ChatApi's tests see it (docs/features/web-pages.md#tests). ChatApi requests a page from the server
// before it is framed (worker/WebPreview.ts), and a test never reaches the internet: the pages a test names answer here,
// with the headers it gives them, any other outside page is unreachable, and this machine (Electric, a local test
// server) is the real fetch. Outside sites are a third party, like the model provider, so they are scripted; ChatApi,
// `@smthrs/views`' check and Effect's fetch client all run for real. The end-to-end tests serve real pages instead
// (e2e/web-page.spec.ts).

/** A page a test serves: its status, headers and HTML. */
export interface Page {
  readonly status?: number
  readonly headers?: Record<string, string>
  readonly html?: string
  readonly body?: Uint8Array<ArrayBuffer>
}

/** A page that lets others frame it, with a title, a description and an icon. */
export const framable = (title = "Frames welcome"): Page => ({
  html: `<!doctype html><title>${title}</title><meta name="description" content="A page that lets others frame it.">` +
    `<link rel="icon" href="/icon.png">`,
})

/** A page that refuses to be framed with `X-Frame-Options: DENY`, with a title and a description. */
export const refusing = (title = "Frames refused"): Page => ({
  headers: { "x-frame-options": "DENY" },
  html: `<!doctype html><title>${title}</title><meta name="description" content="A page that never shows in a frame.">`,
})

/** A one-pixel PNG served by an outside site's icon URL. */
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOioAAAAASUVORK5CYII="
export const iconPage: Page = {
  headers: { "content-type": "image/png" },
  body: Uint8Array.from(atob(pixel), (byte) => byte.charCodeAt(0)),
}
export const inlineIcon = `data:image/png;base64,${pixel}`

/** A Markdown page, as a docs site serves one of its pages or its `llms.txt` index. */
export const markdown = (text: string): Page => ({ headers: { "content-type": "text/markdown; charset=utf-8" }, html: text })

/** Hosts on this machine, which the real fetch reaches. */
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * A fetch where `pages`, by URL, answer as given, every other outside page is unreachable, and this machine is the real
 * fetch. `asked` hears each outside URL requested, in order.
 */
export const outsideWeb = (
  pages: Readonly<Record<string, Page>> = {},
  asked: Array<string> = [],
): typeof globalThis.fetch =>
(input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (LOCAL.has(url.hostname)) return globalThis.fetch(input, init)
  asked.push(url.href)
  const page = pages[url.href]
  if (page === undefined) return Promise.reject(new TypeError("fetch failed: the outside web is offline in tests"))
  return Promise.resolve(
    new Response(page.body ?? page.html ?? "", {
      status: page.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...page.headers },
    }),
  )
}
