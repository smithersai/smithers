// Early parallel prefetch and authenticated first-paint for cold `/$owner/$repo` loads.
//
// Bundled into index.html's inline script beside src/firstPaint/shell.ts so `/role`, `/home` and `/about` start
// fetching as the document parses (t ≈ 120 ms) instead of waiting for JS, the engine worker and SQLite:
// - `/about` uses standard browser HTTP caching (`public, max-age=...`), warming the shared HTTP cache for both this
//   first paint and the engine worker's `repo/about` flow.
// - `/role` and `/home` are fetched with `credentials: "same-origin", cache: "no-store"` strictly under a shared
//   `smithers-data` Web Lock with the wipe mark absent, held in memory only, and consumed at most once by `main.tsx`.
// - When the edge did not already paint public content (e.g., an authenticated visit to a gated repo or an offline SW
//   shell), once `/role` grants access and `/about` answers, this renders the repository's home blocks or root entries
//   immediately and hands off cleanly the moment React mounts `#root main` (or revokes on wipe/pagehide/navigation).
import { DATA_LOCK, WIPE } from "../wipe"

export const REPO_PREFETCH_GLOBAL = "__smithersRepoPrefetch"
const PREFETCH_NODE = "first-paint-repo"
const PREFETCH_TTL_MS = 15_000
const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const RESERVED = new Set([
  "app", "api", "assets", "docs", "changelogs", "migration", "privacy", "terms", "refunds", "demo", "bug",
  "flows", "settings", ".well-known",
])

export interface RepoTarget {
  readonly owner: string
  readonly name: string
}

export const parseRepoTarget = (pathname: string): RepoTarget | undefined => {
  const bare = pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname
  const parts = bare.split("/")
  if (parts.length !== 3 || parts[0] !== "") return undefined
  const owner = parts[1]!
  const name = parts[2]!
  if (!NAME.test(owner) || !NAME.test(name) || RESERVED.has(owner.toLowerCase())) return undefined
  return { owner, name }
}

export interface RepoPrefetchHandle {
  /** Consumes an in-flight/resolved early GET response once for `pathname`, or `undefined` if unavailable/revoked. */
  readonly take: (pathname: string) => Promise<Response> | undefined
  /** Revokes any painted node, aborts pending fetches, and clears in-memory responses. */
  readonly revoke: () => void
}

interface RoleBody {
  readonly role?: string | null
  readonly readable?: boolean
  readonly public?: boolean
}

interface AboutBody {
  readonly name?: string
  readonly description?: string | null
  readonly home?: string | null
  readonly root?: ReadonlyArray<{ readonly name?: string; readonly kind?: string }>
}

interface Block {
  readonly type?: string
  readonly title?: string
  readonly tagline?: string
  readonly text?: string
}

interface Section {
  readonly audience?: string
  readonly blocks?: ReadonlyArray<Block>
}

const unmarked = (marks: Pick<Storage, "getItem">): boolean => {
  try {
    return marks.getItem(WIPE) === null
  } catch {
    // expected: storage that refuses reads cannot prove the device unmarked, so nothing is prefetched
    return false
  }
}

const renderAuthorizedRepo = (doc: Document, target: RepoTarget, about: AboutBody, role: RoleBody): HTMLElement => {
  const node = doc.createElement("div")
  node.id = PREFETCH_NODE
  node.className = "edge-shell"
  node.setAttribute(
    "style",
    "position:fixed;inset:0;z-index:2147482999;overflow:auto;background:inherit;",
  )
  const main = doc.createElement("main")
  main.className = "edge-repo"
  const header = doc.createElement("header")
  header.className = "edge-repo-header"
  const h1 = doc.createElement("h1")
  const rawName = about.name ?? `${target.owner}/${target.name}`
  const slash = rawName.indexOf("/")
  const owner = slash === -1 ? target.owner : rawName.slice(0, slash)
  const name = slash === -1 ? target.name : rawName.slice(slash + 1)
  h1.textContent = `${owner} / ${name}`
  header.append(h1)
  main.append(header)

  if (typeof about.description === "string" && about.description !== "") {
    const desc = doc.createElement("p")
    desc.className = "edge-repo-desc"
    desc.textContent = about.description
    main.append(desc)
  }

  let paintedHome = false
  if (typeof about.home === "string" && about.home.trim() !== "") {
    try {
      const parsed = JSON.parse(about.home) as { readonly sections?: ReadonlyArray<Section>; readonly blocks?: ReadonlyArray<Block> }
      const viewerRole = role.role
      const isMaintainer = viewerRole === "maintainer" || viewerRole === "admin"
      const isContributor = isMaintainer || viewerRole === "member" || viewerRole === "contributor"
      const sections: ReadonlyArray<Section> = Array.isArray(parsed.sections)
        ? parsed.sections.filter((s) =>
            s.audience === undefined || s.audience === "everyone" ||
            (s.audience === "contributor" && isContributor) ||
            (s.audience === "maintainer" && isMaintainer),
          )
        : Array.isArray(parsed.blocks)
        ? [{ blocks: parsed.blocks }]
        : []
      for (const section of sections.slice(0, 4)) {
        for (const block of (section.blocks ?? []).slice(0, 6)) {
          if ((block.type === "hero" || block.type === "text") && (block.title || block.tagline || block.text)) {
            const card = doc.createElement("section")
            card.className = "edge-repo-card"
            if (block.title) {
              const h2 = doc.createElement("h2")
              h2.textContent = block.title
              card.append(h2)
            }
            if (block.tagline) {
              const tag = doc.createElement("p")
              tag.textContent = block.tagline
              card.append(tag)
            }
            if (block.text) {
              const p = doc.createElement("p")
              p.textContent = block.text
              card.append(p)
            }
            main.append(card)
            paintedHome = true
          }
        }
      }
    } catch {
      // expected: malformed home.json falls back to directory list
    }
  }

  if (!paintedHome && Array.isArray(about.root) && about.root.length > 0) {
    const card = doc.createElement("section")
    card.className = "edge-repo-card"
    const ul = doc.createElement("ul")
    ul.className = "edge-repo-list"
    for (const entry of about.root.slice(0, 20)) {
      if (typeof entry.name !== "string") continue
      const li = doc.createElement("li")
      const kind = doc.createElement("span")
      kind.className = "edge-repo-kind"
      kind.textContent = entry.kind === "dir" ? "dir" : "file"
      const label = doc.createElement("span")
      label.textContent = entry.name
      li.append(kind, label)
      ul.append(li)
    }
    card.append(ul)
    main.append(card)
  }

  node.append(main)
  return node
}

export interface RepoPrefetchHost {
  readonly window: Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"> & {
    readonly location: Pick<Location, "pathname" | "search">
  }
  readonly document: Document
  readonly locks: Pick<LockManager, "request"> | undefined
  readonly fetch: typeof fetch
  readonly marks: Pick<Storage, "getItem">
  readonly channel: (name: string) => Pick<BroadcastChannel, "close"> & { onmessage: ((event: MessageEvent) => void) | null }
  readonly now: () => number
}

export const startRepoPrefetch = (host: RepoPrefetchHost): RepoPrefetchHandle | undefined => {
  const target = parseRepoTarget(host.window.location.pathname)
  if (target === undefined || !unmarked(host.marks)) return undefined

  const base = `/api/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`
  const rolePath = `${base}/role`
  const homePath = `${base}/home`
  const aboutPath = `${base}/about`
  const originPath = host.window.location.pathname

  let revoked = false
  let node: HTMLElement | undefined
  let observer: MutationObserver | undefined
  let releaseLock: (() => void) | undefined
  const expiresAt = host.now() + PREFETCH_TTL_MS
  const controller = new AbortController()
  const entries = new Map<string, Promise<Response>>()
  const wipes = host.channel(WIPE)
  const cleanups: Array<() => void> = []

  const revoke = () => {
    if (revoked) return
    revoked = true
    entries.clear()
    controller.abort()
    node?.remove()
    node = undefined
    observer?.disconnect()
    observer = undefined
    releaseLock?.()
    releaseLock = undefined
    wipes.onmessage = null
    wipes.close()
    for (const stop of cleanups.splice(0)) stop()
  }

  const timer = host.window.setTimeout(revoke, PREFETCH_TTL_MS)
  cleanups.push(() => host.window.clearTimeout(timer))
  wipes.onmessage = revoke
  const onStorage = (event: StorageEvent) => {
    if ((event.key === WIPE && event.newValue !== null) || event.key === null) revoke()
  }
  host.window.addEventListener("storage", onStorage)
  host.window.addEventListener("pagehide", revoke)
  host.window.addEventListener("popstate", revoke)
  cleanups.push(() => {
    host.window.removeEventListener("storage", onStorage)
    host.window.removeEventListener("pagehide", revoke)
    host.window.removeEventListener("popstate", revoke)
  })

  // Warm public /about immediately in the browser's standard HTTP cache (serves both first-paint and engine.worker).
  // expected: prefetch network failures fall through cleanly to the app's own RepoClient read
  const aboutPromise = host.fetch(aboutPath, { credentials: "same-origin", signal: controller.signal }).catch(() => undefined)

  const runLocked = () => {
    if (revoked || !unmarked(host.marks)) {
      revoke()
      return
    }
    const rolePromise = host.fetch(rolePath, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
    const homePromise = host.fetch(homePath, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
    // expected: prevent unhandledrejection if revoked/unconsumed; consumers still observe rejection via take()
    void rolePromise.catch(() => undefined)
    // expected: prevent unhandledrejection if revoked/unconsumed; consumers still observe rejection via take()
    void homePromise.catch(() => undefined)
    entries.set(rolePath.toLowerCase(), rolePromise)
    entries.set(homePath.toLowerCase(), homePromise)

    // If the edge did not already render public repo content (e.g., signed-in visit to a gated repo like
    // /evmts/guillotine, or a SW-cached index.html), paint authorized content as soon as /role + /about settle.
    const alreadyEdgePublic = host.document.querySelector('[data-edge-first-paint="repo-public"]') !== null
    if (!alreadyEdgePublic) {
      const readJson = async <T>(promise: Promise<Response | undefined>): Promise<T | undefined> => {
        try {
          const response = await promise
          if (response === undefined || !response.ok) return undefined
          return (await response.clone().json()) as T
        } catch {
          // expected: an aborted, failed or malformed early prefetch paints nothing and leaves the app's own read
          return undefined
        }
      }
      void Promise.all([readJson<RoleBody>(rolePromise), readJson<AboutBody>(aboutPromise)]).then(([role, about]) => {
        if (revoked || !unmarked(host.marks) || host.now() >= expiresAt) return
        if (host.window.location.pathname !== originPath) return revoke()
        if (role === undefined || about === undefined) return
        const allowed = role.role != null || role.readable === true || role.public === true
        if (!allowed) return
        // If React has already mounted an interactive screen inside #root (not the static edge shell), do not cover it.
        const root = host.document.getElementById("root")
        if (root !== null && root.querySelector('[data-edge-first-paint]') === null && root.childElementCount > 0) return
        node = renderAuthorizedRepo(host.document, target, about, role)
        host.document.body.prepend(node)
        const checkSettled = () => {
          const r = host.document.getElementById("root")
          if (r !== null && r.querySelector('[data-edge-first-paint]') === null && r.childElementCount > 0) {
            node?.remove()
            node = undefined
            observer?.disconnect()
            observer = undefined
          }
        }
        const Observer = (host.window as unknown as { readonly MutationObserver?: typeof MutationObserver }).MutationObserver
        if (Observer !== undefined) {
          observer = new Observer(checkSettled)
          observer.observe(host.document.documentElement, { childList: true, subtree: true })
        }
        checkSettled()
      })
    }
  }

  if (host.locks !== undefined) {
    void host.locks
      .request(DATA_LOCK, { mode: "shared", signal: controller.signal }, () => {
        runLocked()
        return new Promise<void>((resolve) => {
          releaseLock = resolve
          if (revoked) resolve()
        })
      })
      // expected: an aborted or unavailable Web Lock revokes the early prefetch cleanly
      .catch(() => revoke())
  } else {
    runLocked()
  }

  return {
    take: (pathname: string) => {
      if (revoked || !unmarked(host.marks) || host.now() >= expiresAt) {
        revoke()
        return undefined
      }
      const key = pathname.toLowerCase()
      const hit = entries.get(key)
      if (hit === undefined) return undefined
      entries.delete(key)
      return hit
    },
    revoke,
  }
}

/** Takes the early repo prefetch handle once from `target` (window). */
export const takeRepoPrefetch = (target: object): RepoPrefetchHandle | undefined => {
  const holder = target as Record<string, unknown>
  const handle = holder[REPO_PREFETCH_GLOBAL] as RepoPrefetchHandle | undefined
  delete holder[REPO_PREFETCH_GLOBAL]
  return handle
}

/** Wraps `fetch` so cold `/role` and `/home` GET requests reuse the inline prefetch response once. */
export const prefetchingFetch = (
  next: typeof globalThis.fetch,
  handle: RepoPrefetchHandle | undefined,
): typeof globalThis.fetch => {
  if (handle === undefined) return next
  return (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    if (method === "GET") {
      const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost")
      const hit = handle.take(url.pathname)
      if (hit !== undefined) {
        // expected: a failed early prefetch falls back transparently to a fresh request through `next`
        return hit.then((response) => response.clone()).catch(() => next(input, init))
      }
    }
    return next(input, init)
  }
}
