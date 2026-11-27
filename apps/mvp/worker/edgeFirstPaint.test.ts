import { afterEach, expect, test } from "vitest"
import { cachedPublicAbout, injectEdgeFirstPaint, parseRepoHomePath, renderRepoShell } from "./edgeFirstPaint.ts"

const SHELL =
  '<!doctype html><html><head><title>Smithers</title><meta property="og:title" content="Smithers" /><meta property="og:description" content="Automate maintaining your codebase" /></head><body><div id="root"></div></body></html>'

const previousCaches = (globalThis as { caches?: unknown }).caches
afterEach(() => {
  ;(globalThis as { caches?: unknown }).caches = previousCaches
})

const installEdgeCache = (opts?: {
  readonly failMatch?: boolean
  readonly failPut?: boolean
  readonly store?: Map<string, Response>
}) => {
  const store = opts?.store ?? new Map<string, Response>()
  ;(globalThis as { caches?: unknown }).caches = {
    default: {
      match: async (req: Request) => {
        if (opts?.failMatch) throw new Error("match failed")
        return store.get(req.url)?.clone()
      },
      put: async (req: Request, res: Response) => {
        if (opts?.failPut) throw new Error("put failed")
        store.set(req.url, res.clone())
      },
    },
  }
  return store
}

const makeCtx = () => {
  const pending: Array<Promise<unknown>> = []
  return {
    pending,
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise)
      },
    } as unknown as ExecutionContext,
  }
}

test("parseRepoHomePath matches /$owner/$repo only and rejects invalid encodings", () => {
  expect(parseRepoHomePath("/evmts/guillotine")).toEqual({ owner: "evmts", name: "guillotine" })
  expect(parseRepoHomePath("/smithersai/vibelang/")).toEqual({ owner: "smithersai", name: "vibelang" })
  expect(parseRepoHomePath("/")).toBeUndefined()
  expect(parseRepoHomePath("/app")).toBeUndefined()
  expect(parseRepoHomePath("/app/flows")).toBeUndefined()
  expect(parseRepoHomePath("/evmts/guillotine/issues")).toBeUndefined()
  expect(parseRepoHomePath("/%E0%A4%A/guillotine")).toBeUndefined()
})

test("injectEdgeFirstPaint leaves HTML without #root or non-repo paths untouched and renders landing at /", async () => {
  let calls = 0
  const chatApi = {
    fetch: async () => {
      calls++
      return new Response("nope", { status: 500 })
    },
  } as unknown as Fetcher

  const noRoot = await injectEdgeFirstPaint(
    "<html><body>no root</body></html>",
    new URL("https://smithers.sh/"),
    new Request("https://smithers.sh/"),
    chatApi,
  )
  expect(noRoot).toBe("<html><body>no root</body></html>")

  const appRoute = await injectEdgeFirstPaint(
    SHELL,
    new URL("https://smithers.sh/app/flows"),
    new Request("https://smithers.sh/app/flows"),
    chatApi,
  )
  expect(appRoute).toBe(SHELL)

  const landing = await injectEdgeFirstPaint(
    SHELL,
    new URL("https://smithers.sh/"),
    new Request("https://smithers.sh/"),
    chatApi,
  )
  expect(calls).toBe(0)
  expect(landing).toContain('data-edge-first-paint="landing"')
  expect(landing).toContain('<h1 aria-label="Smithers">Smithers</h1>')
  expect(landing).toContain("Automate maintaining your codebase")
})

test("injectEdgeFirstPaint renders only everyone sections for publicly readable repos, supports every block type, and never leaks maintainer sections", async () => {
  const seenCookies: Array<string | null> = []
  const chatApi = {
    fetch: async (req: Request) => {
      seenCookies.push(req.headers.get("cookie"))
      const pathname = new URL(req.url).pathname
      if (pathname.endsWith("/role")) return Response.json({ role: null, own: false, readable: true, synced: true })
      if (pathname.endsWith("/home")) return Response.json({ audience: "everyone", curated: null })
      if (pathname.endsWith("/about")) {
        return Response.json({
          name: "smithersai/vibelang",
          description: "Write Effect programs in TypeScript syntax.",
          defaultBranch: "main",
          stars: 27,
          forks: 4,
          home: JSON.stringify({
            sections: [
              { title: "Secret Maintainer", audience: "maintainer", blocks: [{ type: "text", title: "Private Ops", text: "Do not leak" }] },
              {
                audience: "everyone",
                blocks: [
                  {
                    type: "hero",
                    title: "VibeLang",
                    tagline: "Effect in TS syntax",
                    text: "Compiles cleanly",
                    install: "pnpm add vibelang",
                    actions: [
                      { label: "Docs", url: "/smithersai/vibelang/docs" },
                      { label: "GitHub", href: "https://github.com/smithersai/vibelang" },
                      { label: "Bad", url: "javascript:alert(1)" },
                      { label: "ProtoRel", url: "//evil.test/x" },
                      { label: "", url: "/ok" },
                      { url: "/missing-label" },
                      { label: "MissingUrl" },
                    ],
                  },
                  { type: "hero", tagline: "Tagline only" },
                  { type: "hero", text: "Text only hero" },
                  { type: "hero" },
                  { type: "text", title: "Overview", text: "Typed effects" },
                  { type: "text", text: "Body only" },
                  { type: "text", title: "Title only" },
                ],
              },
              {
                audience: "everyone",
                blocks: [
                  { type: "links", title: "Resources", links: [{ label: "Guide", url: "/guide" }] },
                  { type: "links", links: [{ label: "Bare", url: "/bare" }] },
                  { type: "links", links: [{ label: "Skip", url: "ftp://bad" }] },
                ],
              },
              {
                blocks: [
                  { type: "stats", stats: [{ value: "100%", label: "typed" }, { value: "0" }, { label: "only" }, {}] },
                  { type: "stats", stats: [{}] },
                  {
                    type: "cards",
                    title: "Highlights",
                    cards: [{ title: "Fast", text: "Instant builds" }, { title: "Title only" }, { text: "Text only" }, {}],
                  },
                  { type: "cards", cards: [{ title: "Untitled group" }] },
                  { type: "cards", cards: [{}] },
                  { type: "unknown" },
                ],
              },
              {},
            ],
          }),
        })
      }
      return new Response(null, { status: 404 })
    },
  } as unknown as Fetcher

  const req = new Request("https://smithers.sh/smithersai/vibelang", { headers: { cookie: "session=secret" } })
  const html = await injectEdgeFirstPaint(SHELL, new URL(req.url), req, chatApi)
  expect(seenCookies.every((cookie) => cookie === null)).toBe(true)
  expect(html).toContain('data-edge-first-paint="repo-public"')
  expect(html).toContain("<h2>VibeLang</h2>")
  expect(html).toContain("pnpm add vibelang")
  expect(html).toContain('class="edge-btn edge-btn-solid"')
  expect(html).toContain('target="_blank" rel="noopener noreferrer"')
  expect(html).not.toContain("javascript:")
  expect(html).not.toContain("evil.test")
  expect(html).not.toContain("Private Ops")
  expect(html).not.toContain("Do not leak")
  expect(html).toContain("27 stars")
  expect(html).toContain("4 forks")
  expect(html).toContain("100%")
  expect(html).toContain("Highlights")
  expect(html).toContain("<title>smithersai/vibelang · Smithers</title>")
  expect(html).toContain('<meta property="og:description" content="Write Effect programs in TypeScript syntax." />')
})

test("renderRepoShell covers flat blocks home.json, curated sections, malformed home, root tree, and README fallbacks", () => {
  // Flat `blocks` home.json and `name` without slash
  const flat = renderRepoShell(
    "acme",
    "demo",
    {
      publicReadable: true,
      about: { name: "flatname", home: JSON.stringify({ blocks: [{ type: "text", title: "Flat" }] }) },
      home: null,
    },
    false,
  )
  expect(flat).toContain("<h1>acme / demo</h1>")
  expect(flat).toContain("<h2>Flat</h2>")

  // All sections restricted to maintainer -> falls back to curated everyone sections
  const curated = renderRepoShell(
    "acme",
    "demo",
    {
      publicReadable: true,
      about: { name: "acme/demo", home: JSON.stringify({ sections: [{ audience: "maintainer", blocks: [] }] }) },
      home: {
        curated: {
          sections: [
            { audience: "maintainer", blocks: [{ type: "text", title: "Hidden" }] },
            { audience: "everyone", blocks: [{ type: "text", title: "Curated Public" }] },
          ],
        },
      },
    },
    false,
  )
  expect(curated).toContain("<h2>Curated Public</h2>")
  expect(curated).not.toContain("Hidden")

  // Malformed home.json + root tree with defaultBranch + README contents (heading + body)
  const treeAndReadme = renderRepoShell(
    "acme",
    "demo",
    {
      publicReadable: true,
      about: {
        name: "acme/demo",
        defaultBranch: "main",
        home: "{bad json",
        root: [
          { name: "src", kind: "dir" },
          { name: "README.md", kind: "file" },
        ],
        readme: { path: "README.md", contents: "# Demo Title\n\n![badge](x.png)\nSee [docs](https://example.com) and `code`.\n```ts\nconst x = 1\n```" },
      },
      home: { curated: { sections: [{ audience: "maintainer", blocks: [] }] } },
    },
    false,
  )
  expect(treeAndReadme).toContain("/acme/demo/tree/main/src")
  expect(treeAndReadme).toContain("/acme/demo/blob/main/README.md")
  expect(treeAndReadme).toContain("<h2>Demo Title</h2>")
  expect(treeAndReadme).toContain("See docs")

  // Root tree without defaultBranch + README with text only (no heading) + empty README + whitespace-only README
  const noBranch = renderRepoShell(
    "acme",
    "demo",
    {
      publicReadable: true,
      about: {
        name: "acme/demo",
        home: "   ",
        root: [{ name: "a.txt", kind: "file" }],
        readme: { path: "README.md", text: "Just plain text paragraph." },
      },
      home: null,
    },
    false,
  )
  expect(noBranch).toContain('href="/acme/demo"')
  expect(noBranch).toContain("<p>Just plain text paragraph.</p>")

  const headingOnlyReadme = renderRepoShell(
    "acme",
    "demo",
    {
      publicReadable: true,
      about: { name: "acme/demo", home: JSON.stringify({}), readme: { path: "README.md", text: "# Only Heading" } },
      home: null,
    },
    false,
  )
  expect(headingOnlyReadme).toContain("<h2>Only Heading</h2>")

  const emptyReadme = renderRepoShell(
    "acme",
    "demo",
    {
      publicReadable: true,
      about: { name: "acme/demo", readme: { path: "README.md", text: "```\ncode only\n```" } },
      home: null,
    },
    false,
  )
  expect(emptyReadme).not.toContain("<section")

  const blankReadme = renderRepoShell(
    "acme",
    "demo",
    {
      publicReadable: true,
      about: { name: "acme/demo", readme: { path: "README.md", text: "   " } },
      home: null,
    },
    false,
  )
  expect(blankReadme).not.toContain("<section")
})

test("injectEdgeFirstPaint never leaks repo content when unauthenticated role says readable: false or fails", async () => {
  const chatApi = {
    fetch: async (req: Request) => {
      const pathname = new URL(req.url).pathname
      if (pathname.endsWith("/role")) return Response.json({ role: null, own: false, readable: false, synced: true })
      if (pathname.endsWith("/about")) {
        return Response.json({
          name: "evmts/guillotine",
          description: "Should not appear in unauth edge HTML",
          home: JSON.stringify({ blocks: [{ type: "text", title: "Hidden Home" }] }),
        })
      }
      return Response.json({ audience: "everyone", curated: null })
    },
  } as unknown as Fetcher

  const signedOut = await injectEdgeFirstPaint(
    SHELL,
    new URL("https://smithers.sh/evmts/guillotine"),
    new Request("https://smithers.sh/evmts/guillotine"),
    chatApi,
  )
  expect(signedOut).toContain('data-edge-first-paint="repo-chrome"')
  expect(signedOut).toContain("<h1>evmts / guillotine</h1>")
  expect(signedOut).toContain("Sign in with GitHub")
  expect(signedOut).not.toContain("Hidden Home")
  expect(signedOut).not.toContain("__smithers_edge_seed")

  const signedIn = await injectEdgeFirstPaint(
    SHELL,
    new URL("https://smithers.sh/evmts/guillotine"),
    new Request("https://smithers.sh/evmts/guillotine", { headers: { cookie: "smithers_session=abc" } }),
    chatApi,
  )
  expect(signedIn).toContain("<h1>evmts / guillotine</h1>")
  expect(signedIn).not.toContain("Sign in with GitHub")
  expect(signedIn).not.toContain("Hidden Home")

  // Non-OK role response and throwing CHAT_API both fall back cleanly to neutral chrome
  const notOkApi = { fetch: async () => new Response(null, { status: 500 }) } as unknown as Fetcher
  const failedRole = await injectEdgeFirstPaint(
    SHELL,
    new URL("https://smithers.sh/acme/down"),
    new Request("https://smithers.sh/acme/down"),
    notOkApi,
  )
  expect(failedRole).toContain('data-edge-first-paint="repo-chrome"')

  const throwingApi = {
    fetch: async () => {
      throw new Error("boom")
    },
  } as unknown as Fetcher
  const errored = await injectEdgeFirstPaint(
    SHELL,
    new URL("https://smithers.sh/acme/err"),
    new Request("https://smithers.sh/acme/err"),
    throwingApi,
  )
  expect(errored).toContain('data-edge-first-paint="repo-chrome"')
})

test("fetchPublicRepoSnapshot caches at the edge, handles role.public, non-OK about/home, cache failures, and timeouts", async () => {
  const store = installEdgeCache()
  let fetches = 0
  const publicApi = {
    fetch: async (req: Request) => {
      fetches++
      const pathname = new URL(req.url).pathname
      if (pathname.endsWith("/role")) return Response.json({ public: true })
      if (pathname.endsWith("/about")) return Response.json({ name: "acme/pub" })
      return new Response(null, { status: 404 })
    },
  } as unknown as Fetcher

  const first = await injectEdgeFirstPaint(
    SHELL,
    new URL("https://smithers.sh/acme/pub"),
    new Request("https://smithers.sh/acme/pub"),
    publicApi,
  )
  expect(first).toContain('data-edge-first-paint="repo-public"')
  expect(first).toContain("<title>acme/pub · Smithers</title>")
  expect(fetches).toBe(3)
  expect(store.size).toBe(1)

  // Second request hits edge cache directly without calling CHAT_API
  const second = await injectEdgeFirstPaint(
    SHELL,
    new URL("https://smithers.sh/Acme/Pub"),
    new Request("https://smithers.sh/Acme/Pub"),
    publicApi,
  )
  expect(second).toContain('data-edge-first-paint="repo-public"')
  expect(fetches).toBe(3)

  // Cache match & put errors fall back cleanly without failing the response
  installEdgeCache({ failMatch: true, failPut: true })
  const noAboutApi = {
    fetch: async (req: Request) => {
      if (new URL(req.url).pathname.endsWith("/role")) return Response.json({ readable: true })
      return new Response(null, { status: 503 })
    },
  } as unknown as Fetcher
  const degraded = await injectEdgeFirstPaint(
    SHELL,
    new URL("https://smithers.sh/acme/noabout"),
    new Request("https://smithers.sh/acme/noabout"),
    noAboutApi,
  )
  expect(degraded).toContain('data-edge-first-paint="repo-chrome"')

  // Slow CHAT_API hits the 350ms timeout and registers background cache fill with ctx.waitUntil
  installEdgeCache()
  let releaseSlow!: () => void
  const slowApi = {
    fetch: async (req: Request) => {
      await new Promise<void>((resolve) => {
        releaseSlow = resolve
        setTimeout(resolve, 420)
      })
      if (new URL(req.url).pathname.endsWith("/role")) return Response.json({ readable: true })
      if (new URL(req.url).pathname.endsWith("/about")) return Response.json({ name: "acme/slow" })
      return new Response(null, { status: 404 })
    },
  } as unknown as Fetcher
  const { ctx, pending } = makeCtx()
  const timedOut = await injectEdgeFirstPaint(
    SHELL,
    new URL("https://smithers.sh/acme/slow"),
    new Request("https://smithers.sh/acme/slow"),
    slowApi,
    ctx,
  )
  expect(timedOut).toContain('data-edge-first-paint="repo-chrome"')
  expect(pending.length).toBe(1)
  releaseSlow()
  await Promise.all(pending)
})

test("cachedPublicAbout caches only public 200 GET /api/repos/:owner/:name/about responses", async () => {
  const api = {
    fetch: async (req: Request) => {
      const p = new URL(req.url).pathname
      if (p.includes("/private/")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "cache-control": "private, no-store" } })
      }
      if (p.includes("/no-cc/")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
      })
    },
  } as unknown as Fetcher

  // Non-GET, non-about path, and missing caches.default all return undefined
  expect(await cachedPublicAbout(new Request("https://smithers.sh/api/repos/a/b/about", { method: "POST" }), api)).toBeUndefined()
  expect(await cachedPublicAbout(new Request("https://smithers.sh/api/repos/a/b/role"), api)).toBeUndefined()
  expect(await cachedPublicAbout(new Request("https://smithers.sh/api/repos/a/b/about"), api)).toBeUndefined()

  // With cache + ctx.waitUntil, public 200 is cached and served on repeat
  const store = installEdgeCache()
  const { ctx, pending } = makeCtx()
  const res1 = await cachedPublicAbout(new Request("https://smithers.sh/api/repos/Acme/App/about"), api, ctx)
  expect(res1?.status).toBe(200)
  await Promise.all(pending)
  expect(store.size).toBe(1)

  const hit = await cachedPublicAbout(new Request("https://smithers.sh/api/repos/acme/app/about"), api, ctx)
  expect(await hit?.json()).toEqual({ ok: true })

  // Private or missing cache-control responses are returned but not cached
  const priv = await cachedPublicAbout(new Request("https://smithers.sh/api/repos/private/app/about"), api)
  expect(priv?.status).toBe(200)
  const noCc = await cachedPublicAbout(new Request("https://smithers.sh/api/repos/no-cc/app/about"), api)
  expect(noCc?.status).toBe(200)
  expect(store.size).toBe(1)

  // Cache put rejection (both with and without ctx) and match rejection are handled safely
  installEdgeCache({ failPut: true })
  const resPutCtx = await cachedPublicAbout(new Request("https://smithers.sh/api/repos/acme/put1/about"), api, ctx)
  expect(resPutCtx?.status).toBe(200)
  await Promise.all(pending)
  const resPutNoCtx = await cachedPublicAbout(new Request("https://smithers.sh/api/repos/acme/put2/about"), api)
  expect(resPutNoCtx?.status).toBe(200)

  installEdgeCache({ failMatch: true })
  expect(await cachedPublicAbout(new Request("https://smithers.sh/api/repos/acme/err/about"), api)).toBeUndefined()
})
