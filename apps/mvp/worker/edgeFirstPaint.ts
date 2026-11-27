// Edge first-paint HTML and public CDN caching for worker/index.ts.
//
// Delivers meaningful initial content at Cloudflare edge speed (TTFB) for `/` and `/$owner/$repo` without leaking any
// private repository data:
// - Public metadata (`/about`, unauthenticated `/role`, `/home`) is fetched from CHAT_API with NO cookies and cached
//   at the Cloudflare edge PoP (`caches.default`, 60s TTL).
// - Only repositories whose unauthenticated `/role` answers `readable: true` or `public: true` receive full public
//   content in the edge HTML, and only `"everyone"` sections are rendered. Every other repository paints only its
//   neutral `owner / repo` header chrome (plus a sign-in link when no session cookie is present), leaving authorized
//   private content to the browser's locked first-paint and app runtime (decision 0152).
import { isRepository } from "../src/features/repo/contract.ts"

const EDGE_TIMEOUT_MS = 350
const EDGE_CACHE_SECONDS = 60
const MAX_TREE_ENTRIES = 24
const MAX_README_CHARS = 900
const ROOT_PLACEHOLDER = '<div id="root"></div>'

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

/** Parses `/$owner/$repo` (with optional trailing slash) into `{ owner, name }`, or `undefined` for any other path. */
export const parseRepoHomePath = (pathname: string): { readonly owner: string; readonly name: string } | undefined => {
  const bare = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname
  const parts = bare.split("/")
  if (parts.length !== 3 || parts[0] !== "") return undefined
  let owner: string
  let name: string
  try {
    owner = decodeURIComponent(parts[1]!)
    name = decodeURIComponent(parts[2]!)
  } catch {
    return undefined
  }
  return isRepository(owner, name) ? { owner, name } : undefined
}

interface EdgeAbout {
  readonly name: string
  readonly description?: string | null
  readonly defaultBranch?: string
  readonly stars?: number
  readonly forks?: number
  readonly root?: ReadonlyArray<{ readonly name: string; readonly kind: "dir" | "file" }>
  readonly readme?: { readonly path: string; readonly contents?: string; readonly text?: string } | null
  readonly home?: string | null
}

interface EdgeRole {
  readonly readable?: boolean
  readonly public?: boolean
}

interface EdgeHomeAnswer {
  readonly audience?: string
  readonly curated?: {
    readonly defaultBranch?: string
    readonly sections?: ReadonlyArray<EdgeSection>
  } | null
}

interface EdgeLink {
  readonly label?: string
  readonly url?: string
  readonly href?: string
}

interface EdgeBlock {
  readonly type?: string
  readonly title?: string
  readonly tagline?: string
  readonly text?: string
  readonly install?: string
  readonly code?: string
  readonly actions?: ReadonlyArray<EdgeLink>
  readonly links?: ReadonlyArray<EdgeLink>
  readonly stats?: ReadonlyArray<{ readonly value?: string; readonly label?: string }>
  readonly cards?: ReadonlyArray<{ readonly title?: string; readonly text?: string; readonly url?: string }>
}

interface EdgeSection {
  readonly title?: string
  readonly audience?: string
  readonly blocks?: ReadonlyArray<EdgeBlock>
}

interface PublicRepoSnapshot {
  readonly publicReadable: boolean
  readonly about: EdgeAbout | null
  readonly home: EdgeHomeAnswer | null
}

/** Extracts strictly public (`audience === "everyone"` or unset) sections from `.smithers/home.json`. */
const parsePublicHomeSections = (text: string | null | undefined): ReadonlyArray<EdgeSection> | undefined => {
  if (typeof text !== "string" || text.trim() === "") return undefined
  try {
    const parsed = JSON.parse(text) as { readonly sections?: ReadonlyArray<EdgeSection>; readonly blocks?: ReadonlyArray<EdgeBlock> }
    if (Array.isArray(parsed.sections) && parsed.sections.length > 0) {
      const publicSections = parsed.sections.filter(
        (section) => section.audience === undefined || section.audience === "everyone",
      )
      return publicSections.length > 0 ? publicSections : undefined
    }
    if (Array.isArray(parsed.blocks) && parsed.blocks.length > 0) return [{ blocks: parsed.blocks }]
  } catch {
    // expected: malformed home.json falls back to tree/readme preview
  }
  return undefined
}

const safeHref = (raw: string | undefined): string | undefined => {
  if (typeof raw !== "string") return undefined
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw
  if (/^https?:\/\//i.test(raw)) return raw
  return undefined
}

const renderLinkList = (links: ReadonlyArray<EdgeLink> | undefined, buttonClass = false): string => {
  if (!Array.isArray(links) || links.length === 0) return ""
  return links
    .map((link, index) => {
      const href = safeHref(link.url ?? link.href)
      const label = link.label
      if (!href || !label) return ""
      const external = /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ""
      const cls = buttonClass ? ` class="edge-btn${index === 0 ? " edge-btn-solid" : ""}"` : ""
      return `<a href="${escapeHtml(href)}"${cls}${external}>${escapeHtml(label)}</a>`
    })
    .filter(Boolean)
    .join("")
}

const renderBlocks = (sections: ReadonlyArray<EdgeSection>): string => {
  const parts: Array<string> = []
  for (const section of sections.slice(0, 6)) {
    const blocks = Array.isArray(section.blocks) ? section.blocks : []
    for (const block of blocks.slice(0, 8)) {
      if (block.type === "hero" && (block.title || block.tagline || block.text)) {
        const actions = renderLinkList(block.actions, true)
        parts.push(
          `<section class="edge-repo-card">` +
            (block.title ? `<h2>${escapeHtml(block.title)}</h2>` : "") +
            (block.tagline ? `<p><strong>${escapeHtml(block.tagline)}</strong></p>` : "") +
            (block.text ? `<p>${escapeHtml(block.text)}</p>` : "") +
            (block.install ? `<p><code>${escapeHtml(block.install)}</code></p>` : "") +
            (actions ? `<div class="edge-repo-links">${actions}</div>` : "") +
            `</section>`,
        )
      } else if (block.type === "text" && (block.title || block.text)) {
        parts.push(
          `<section class="edge-repo-card">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ""}${block.text ? `<p>${escapeHtml(block.text)}</p>` : ""}</section>`,
        )
      } else if (block.type === "links") {
        const items = renderLinkList(block.links, false)
        if (items) {
          parts.push(
            `<section class="edge-repo-card">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ""}<div class="edge-repo-links">${items}</div></section>`,
          )
        }
      } else if (block.type === "stats" && Array.isArray(block.stats) && block.stats.length > 0) {
        const items = block.stats
          .slice(0, 6)
          .filter((stat: { readonly value?: string; readonly label?: string }) => Boolean(stat.value || stat.label))
          .map((stat: { readonly value?: string; readonly label?: string }) =>
            `<span><strong>${escapeHtml(stat.value ?? "")}</strong> ${escapeHtml(stat.label ?? "")}</span>`,
          )
          .join("")
        if (items) parts.push(`<div class="edge-repo-meta">${items}</div>`)
      } else if (block.type === "cards" && Array.isArray(block.cards) && block.cards.length > 0) {
        const items = block.cards
          .slice(0, 6)
          .filter((card: { readonly title?: string; readonly text?: string }) => Boolean(card.title || card.text))
          .map((card: { readonly title?: string; readonly text?: string }) =>
            `<li><strong>${escapeHtml(card.title ?? "")}</strong>${card.text ? ` — ${escapeHtml(card.text)}` : ""}</li>`,
          )
          .join("")
        if (items) {
          parts.push(
            `<section class="edge-repo-card">${block.title ? `<h2>${escapeHtml(block.title)}</h2>` : ""}<ul class="edge-repo-list">${items}</ul></section>`,
          )
        }
      }
    }
  }
  return parts.join("")
}

const renderReadmeSnippet = (about: EdgeAbout): string => {
  const raw = about.readme?.text ?? about.readme?.contents
  if (typeof raw !== "string" || raw.trim() === "") return ""
  const headingMatch = /^#\s+(.+)$/m.exec(raw)
  const heading = headingMatch ? headingMatch[1]!.replaceAll(/[`*_[\]()]/g, "").trim() : ""
  const cleaned = raw
    .replace(/^#.*$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_README_CHARS)
  if (!heading && !cleaned) return ""
  return `<section class="edge-repo-card">${heading ? `<h2>${escapeHtml(heading)}</h2>` : ""}${cleaned ? `<p>${escapeHtml(cleaned)}</p>` : ""}</section>`
}

/** Static, public first-paint HTML for `/` (Landing). */
export const renderLandingShell = (): string =>
  `<div class="edge-shell edge-landing" data-edge-first-paint="landing">` +
  `<nav class="edge-landing-top" aria-label="Site">` +
  `<a href="/docs">Docs</a>` +
  `<a href="/app/waitlist">Host a repo</a>` +
  `<a href="https://github.com/smithersai/smithers" target="_blank" rel="noopener noreferrer">Source</a>` +
  `</nav>` +
  `<div class="edge-landing-hero">` +
  `<header><h1 aria-label="Smithers">Smithers</h1></header>` +
  `<main>` +
  `<p class="edge-landing-tagline">Automate maintaining your codebase</p>` +
  `<nav class="edge-landing-actions" aria-label="Start">` +
  `<a class="edge-btn edge-btn-solid" href="/app">Get started for free</a>` +
  `</nav>` +
  `</main>` +
  `</div>` +
  `</div>`

/** Edge first-paint HTML for `/$owner/$repo`: public content when publicly readable, else minimal header chrome. */
export const renderRepoShell = (
  owner: string,
  name: string,
  snapshot: PublicRepoSnapshot | undefined,
  hasCookie: boolean,
): string => {
  const displayName = snapshot?.publicReadable && snapshot.about?.name ? snapshot.about.name : `${owner}/${name}`
  const slash = displayName.indexOf("/")
  const shownOwner = slash === -1 ? owner : displayName.slice(0, slash)
  const shownRepo = slash === -1 ? name : displayName.slice(slash + 1)
  const headerTitle = `${escapeHtml(shownOwner)} / ${escapeHtml(shownRepo)}`

  if (!snapshot?.publicReadable || snapshot.about === null) {
    const signIn = hasCookie
      ? ""
      : `<div class="edge-repo-card"><a class="edge-btn edge-btn-solid" href="/api/auth/sign-in?return=${encodeURIComponent(`/${owner}/${name}`)}">Sign in with GitHub</a></div>`
    return `<main class="edge-shell edge-repo" aria-label="Repository" data-edge-first-paint="repo-chrome">` +
      `<header class="edge-repo-header"><h1>${headerTitle}</h1></header>${signIn}</main>`
  }

  const { about, home } = snapshot
  const metaParts: Array<string> = []
  if (about.defaultBranch) metaParts.push(`<span>Branch: ${escapeHtml(about.defaultBranch)}</span>`)
  if (typeof about.stars === "number") metaParts.push(`<span>${about.stars.toLocaleString("en-US")} stars</span>`)
  if (typeof about.forks === "number") metaParts.push(`<span>${about.forks.toLocaleString("en-US")} forks</span>`)

  const declaredSections = parsePublicHomeSections(about.home)
  const curatedSections = home?.curated?.sections?.filter(
    (section) => section.audience === undefined || section.audience === "everyone",
  )
  const sectionsHtml = declaredSections
    ? renderBlocks(declaredSections)
    : curatedSections && curatedSections.length > 0
    ? renderBlocks(curatedSections)
    : ""

  const treeEntries = Array.isArray(about.root) ? about.root.slice(0, MAX_TREE_ENTRIES) : []
  const treeHtml = !sectionsHtml && treeEntries.length > 0
    ? `<section class="edge-repo-card"><ul class="edge-repo-list">${treeEntries
        .map((entry) => {
          const kind = entry.kind === "dir" ? "dir" : "file"
          const href = about.defaultBranch
            ? `/${encodeURIComponent(shownOwner)}/${encodeURIComponent(shownRepo)}/${kind === "dir" ? "tree" : "blob"}/${encodeURIComponent(about.defaultBranch)}/${entry.name.split("/").map(encodeURIComponent).join("/")}`
            : `/${encodeURIComponent(shownOwner)}/${encodeURIComponent(shownRepo)}`
          return `<li><span class="edge-repo-kind">${kind}</span><a href="${escapeHtml(href)}">${escapeHtml(entry.name)}</a></li>`
        })
        .join("")}</ul></section>`
    : ""

  const readmeHtml = !sectionsHtml ? renderReadmeSnippet(about) : ""

  return (
    `<main class="edge-shell edge-repo" aria-label="Repository" data-edge-first-paint="repo-public">` +
    `<header class="edge-repo-header"><h1>${headerTitle}</h1></header>` +
    (about.description ? `<p class="edge-repo-desc">${escapeHtml(about.description)}</p>` : "") +
    (metaParts.length > 0 ? `<div class="edge-repo-meta">${metaParts.join("")}</div>` : "") +
    sectionsHtml +
    treeHtml +
    readmeHtml +
    `</main>`
  )
}

const defaultEdgeCache = (): Cache | undefined => {
  const storage = (globalThis as { readonly caches?: { readonly default?: Cache } }).caches
  return storage?.default
}

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Fetches unauthenticated public repo metadata from CHAT_API and caches it at the Cloudflare edge PoP. */
const fetchPublicRepoSnapshot = async (
  chatApi: Fetcher,
  origin: string,
  owner: string,
  name: string,
  ctx?: ExecutionContext,
): Promise<PublicRepoSnapshot | undefined> => {
  const cache = defaultEdgeCache()
  const encodedOwner = encodeURIComponent(owner.toLowerCase())
  const encodedName = encodeURIComponent(name.toLowerCase())
  const cacheKey = new Request(`${origin}/__edge_repo_fp/${encodedOwner}/${encodedName}`, { method: "GET" })

  if (cache !== undefined) {
    try {
      const hit = await cache.match(cacheKey)
      if (hit !== undefined && hit.ok) {
        return (await hit.json()) as PublicRepoSnapshot
      }
    } catch {
      // expected: edge cache unavailable in local/unit environments
    }
  }

  const load = (async (): Promise<PublicRepoSnapshot | undefined> => {
    try {
      const base = `${origin}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
      const [roleRes, aboutRes, homeRes] = await Promise.all([
        chatApi.fetch(new Request(`${base}/role`, { method: "GET" })),
        chatApi.fetch(new Request(`${base}/about`, { method: "GET" })),
        chatApi.fetch(new Request(`${base}/home`, { method: "GET" })),
      ])
      if (!roleRes.ok) return undefined
      const role = (await roleRes.json()) as EdgeRole
      const publicReadable = role.readable === true || role.public === true
      const about = publicReadable && aboutRes.ok ? ((await aboutRes.json()) as EdgeAbout) : null
      const home = publicReadable && homeRes.ok ? ((await homeRes.json()) as EdgeHomeAnswer) : null
      const snapshot: PublicRepoSnapshot = { publicReadable, about, home }
      if (cache !== undefined) {
        const stored = new Response(JSON.stringify(snapshot), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${EDGE_CACHE_SECONDS}`,
          },
        })
        await cache.put(cacheKey, stored).catch(() => undefined)
      }
      return snapshot
    } catch {
      return undefined
    }
  })()

  const settled = await withTimeout(load, EDGE_TIMEOUT_MS)
  if (settled === undefined && ctx !== undefined) {
    ctx.waitUntil(load)
  }
  return settled
}

/** Edge-caches public `GET /api/repos/:owner/:name/about` responses at the nearest Cloudflare PoP. */
export const cachedPublicAbout = async (
  request: Request,
  chatApi: Fetcher,
  ctx?: ExecutionContext,
): Promise<Response | undefined> => {
  if (request.method !== "GET") return undefined
  const url = new URL(request.url)
  const segments = url.pathname.split("/")
  if (segments.length !== 6 || segments[1] !== "api" || segments[2] !== "repos" || segments[5] !== "about") {
    return undefined
  }
  const cache = defaultEdgeCache()
  if (cache === undefined) return undefined
  const cacheKey = new Request(
    `${url.origin}/api/repos/${encodeURIComponent(segments[3]!.toLowerCase())}/${encodeURIComponent(segments[4]!.toLowerCase())}/about`,
    { method: "GET" },
  )
  try {
    const hit = await cache.match(cacheKey)
    if (hit !== undefined) return hit
  } catch {
    return undefined
  }
  const response = await chatApi.fetch(request)
  const cc = response.headers.get("cache-control") ?? ""
  if (response.status === 200 && cc.includes("public")) {
    const clone = response.clone()
    if (ctx !== undefined) ctx.waitUntil(cache.put(cacheKey, clone).catch(() => undefined))
    else await cache.put(cacheKey, clone).catch(() => undefined)
  }
  return response
}

/** Injects CDN-speed edge first-paint content into HTML for `/` and `/$owner/$repo` when the shell has `#root`. */
export const injectEdgeFirstPaint = async (
  html: string,
  url: URL,
  request: Request,
  chatApi: Fetcher,
  ctx?: ExecutionContext,
): Promise<string> => {
  if (!html.includes(ROOT_PLACEHOLDER)) return html

  if (url.pathname === "/") {
    return html.replace(ROOT_PLACEHOLDER, `<div id="root">${renderLandingShell()}</div>`)
  }

  const repo = parseRepoHomePath(url.pathname)
  if (repo === undefined) return html

  const hasCookie = (request.headers.get("cookie") ?? "").trim() !== ""
  const snapshot = await fetchPublicRepoSnapshot(chatApi, url.origin, repo.owner, repo.name, ctx)
  let out = html.replace(ROOT_PLACEHOLDER, `<div id="root">${renderRepoShell(repo.owner, repo.name, snapshot, hasCookie)}</div>`)
  if (snapshot?.publicReadable && snapshot.about !== null) {
    const title = `${escapeHtml(snapshot.about.name)} · Smithers`
    out = out.replace("<title>Smithers</title>", `<title>${title}</title>`)
    out = out.replace(
      '<meta property="og:title" content="Smithers" />',
      `<meta property="og:title" content="${title}" />`,
    )
    if (snapshot.about.description) {
      out = out.replace(
        '<meta property="og:description" content="Automate maintaining your codebase" />',
        `<meta property="og:description" content="${escapeHtml(snapshot.about.description)}" />`,
      )
    }
  }
  return out
}
