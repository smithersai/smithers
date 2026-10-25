// What the PWA's service worker keeps (vite.config.ts, docs/features/web-pages.md#the-app-around-a-frame): the app's
// own shell, and nothing else. Nothing here imports a library, so the build config can.

/** What Workbox hands a runtime route's matcher about one request. */
export interface ShellRequest {
  readonly url: URL
  readonly sameOrigin: boolean
  readonly request: { readonly method: string; readonly destination: string }
}

/**
 * The docs site's page folders on the app's hostname. Each answers bare (`/docs`, which the docs site redirects to
 * `/docs/`) and with anything under it, never as a prefix such as `/docs*`, which would take `/docsify/docsify` from
 * the app's repositories too.
 */
export const DOCS_SITE_FOLDERS = ["/docs", "/changelogs", "/migration", "/privacy", "/terms", "/refunds", "/demo", "/bug"]

/**
 * The paths the docs site (apps/site) serves on the app's hostname, as Cloudflare route paths: a trailing `*` matches
 * any rest, a query included, and anything else only that path with no query. infra/DocsSite.ts routes each one to the
 * docs site, so the app never answers them, and neither does its service worker (docs/infrastructure.md#domain). A
 * file takes a trailing `*` so that its query still reaches the docs site; a bare folder with a query reaches the
 * app's Worker, which sends it on with a slash (worker/index.ts).
 */
export const DOCS_SITE_PATHS = [
  ...DOCS_SITE_FOLDERS.flatMap((folder) => [folder, `${folder}/*`]),
  ...["/_astro/", "/pagefind/", "/images/", "/media/"].map((folder) => `${folder}*`),
  ...[
    "/llms.txt",
    "/llms-full.txt",
    "/robots.txt",
    "/sitemap-index.xml",
    "/sitemap-0.xml",
    "/favicon.svg",
    "/favicon.png",
    "/apple-touch-icon.png",
    "/icon.png",
  ].map((file) => `${file}*`),
]

const exactly = (path: string) => path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/**
 * {@link DOCS_SITE_PATHS} as one pattern over a path, with or without its query, as Workbox matches navigations: a
 * whole path ends at `?` or the end.
 */
export const DOCS_SITE = new RegExp(
  `^(?:${DOCS_SITE_PATHS.map((path) => (path.endsWith("*") ? exactly(path.slice(0, -1)) : `${exactly(path)}(?:\\?|$)`)).join("|")})`,
)

/**
 * Whether the service worker keeps `request` in its shell cache, network first: a `GET` of the app's own origin
 * outside `/api/` and the docs site's paths, for a module a reload needs offline. Never a frame's document: an outside
 * page `app/web/open` embeds is another origin's, which this worker never sees, and a frame of the app itself is
 * refused (`frame-ancestors 'none'`), so neither is cached or answered from the shell.
 *
 * Workbox copies this function's source into the service worker, so it can't name anything outside itself: the
 * pattern below is {@link DOCS_SITE}'s, written out (src/pwa.test.ts holds the two equal).
 */
export const shellCaches = ({ url, sameOrigin, request }: ShellRequest): boolean =>
  sameOrigin &&
  request.method === "GET" &&
  request.destination !== "iframe" &&
  !url.pathname.startsWith("/api/") &&
  !/^(?:\/docs(?:\?|$)|\/docs\/|\/changelogs(?:\?|$)|\/changelogs\/|\/migration(?:\?|$)|\/migration\/|\/privacy(?:\?|$)|\/privacy\/|\/terms(?:\?|$)|\/terms\/|\/refunds(?:\?|$)|\/refunds\/|\/demo(?:\?|$)|\/demo\/|\/bug(?:\?|$)|\/bug\/|\/_astro\/|\/pagefind\/|\/images\/|\/media\/|\/llms\.txt|\/llms-full\.txt|\/robots\.txt|\/sitemap-index\.xml|\/sitemap-0\.xml|\/favicon\.svg|\/favicon\.png|\/apple-touch-icon\.png|\/icon\.png)/.test(url.pathname)

/**
 * The headers every page of the app is served with: it refuses to be framed by any page, its own included. An outside
 * page in a frame may redirect it anywhere, the app's own origin too, and a frame on the app's origin with
 * `allow-scripts allow-same-origin` could remove its own sandbox (docs/features/web-pages.md#security).
 */
export const PAGE_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
} as const

/**
 * The policy index.html sets for what the app frames: only `https:` pages (`app/web/open`'s `embed`), so a frame of
 * `javascript:`, `data:`, `blob:`, `file:` or `http:` never loads, whatever reaches the page.
 */
export const FRAME_POLICY = "frame-src https:"

/** Browser lifecycle sources are host arguments; no timers or retry policy in the app. */
export interface UpdateHost {
  readonly visible: () => boolean
  readonly listen: (trigger: "visible" | "focus" | "navigation", check: () => void) => () => void
  readonly record: (trigger: UpdateTrigger, outcome: "checked" | "failed" | "busy" | "hidden") => void
}
export type UpdateTrigger = "visible" | "focus" | "navigation"

/** Each browser signal asks the browser to check its worker script, including its HTTP cache rules. */
export const watchUpdates = (registration: { readonly update: () => Promise<unknown> }, host: UpdateHost): (() => void) => {
  let checking = false
  const stops = (["visible", "focus", "navigation"] as const).map((trigger) => host.listen(trigger, () => {
    if (!host.visible()) { host.record(trigger, "hidden"); return }
    if (checking) { host.record(trigger, "busy"); return }
    checking = true
    void (async () => {
      try {
        await registration.update()
        host.record(trigger, "checked")
      } catch {
        host.record(trigger, "failed")
      } finally {
        checking = false
      }
    })()
  }))
  return () => { for (const stop of stops) stop() }
}
