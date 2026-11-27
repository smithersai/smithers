import { Window } from "happy-dom"
import { expect, test } from "vitest"
import { WIPE } from "../wipe"
import {
  parseRepoTarget,
  prefetchingFetch,
  REPO_PREFETCH_GLOBAL,
  startRepoPrefetch,
  takeRepoPrefetch,
  type RepoPrefetchHost,
} from "./repoPrefetch"

const hostOf = (
  win: Window,
  overrides: Partial<RepoPrefetchHost> = {},
): RepoPrefetchHost => ({
  window: win as unknown as RepoPrefetchHost["window"],
  document: win.document as unknown as Document,
  locks: undefined,
  fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  marks: { getItem: (k) => win.localStorage.getItem(k) },
  channel: (name) => new BroadcastChannel(name),
  now: () => 1_000,
  ...overrides,
})

test("parseRepoTarget matches only valid non-reserved /$owner/$repo paths", () => {
  expect(parseRepoTarget("/evmts/guillotine")).toEqual({ owner: "evmts", name: "guillotine" })
  expect(parseRepoTarget("/smithersai/vibelang/")).toEqual({ owner: "smithersai", name: "vibelang" })
  expect(parseRepoTarget("/")).toBeUndefined()
  expect(parseRepoTarget("/app/flows")).toBeUndefined()
  expect(parseRepoTarget("/docs/intro")).toBeUndefined()
  expect(parseRepoTarget("/evmts/guillotine/issues")).toBeUndefined()
})

test("startRepoPrefetch warms role, home and about, paints authorized repo with sections/audiences, hands off via MutationObserver and prefetchingFetch", async () => {
  const win = new Window({ url: "https://smithers.test/evmts/guillotine" })
  win.document.body.innerHTML = '<div id="root"><main data-edge-first-paint="repo-chrome"><h1>evmts / guillotine</h1></main></div>'
  const fetched: Array<string> = []
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const u = String(input)
    fetched.push(u)
    if (u.endsWith("/role")) return Response.json({ role: "admin", own: false, readable: true })
    if (u.endsWith("/home")) return Response.json({ audience: "maintainer", curated: null })
    if (u.endsWith("/about")) {
      return Response.json({
        name: "evmts/guillotine",
        description: "High-performance EVM",
        home: JSON.stringify({
          sections: [
            { audience: "everyone", blocks: [{ type: "hero", title: "Guillotine", tagline: "Fast EVM", text: "In Zig" }, { type: "hero", text: "Text only" }, { type: "text", tagline: "Tagline only" }, { type: "text" }, { type: "links" }] },
            { audience: "contributor", blocks: [{ type: "text", title: "Contributors" }] },
            { audience: "maintainer", blocks: [{ type: "text", title: "Maintainers" }] },
            {},
          ],
        }),
      })
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch

  const handle = startRepoPrefetch(hostOf(win, { fetch: fakeFetch }))!
  expect(handle).toBeDefined()
  expect(fetched).toEqual([
    "/api/repos/evmts/guillotine/about",
    "/api/repos/evmts/guillotine/role",
    "/api/repos/evmts/guillotine/home",
  ])

  await new Promise((r) => setTimeout(r, 20))
  const painted = win.document.getElementById("first-paint-repo")?.textContent ?? ""
  expect(painted).toContain("Guillotine")
  expect(painted).toContain("Fast EVM")
  expect(painted).toContain("Contributors")
  expect(painted).toContain("Maintainers")

  // Mounting interactive React content into #root removes the overlay via MutationObserver
  win.document.getElementById("root")!.innerHTML = "<main>Interactive app</main>"
  await new Promise((r) => setTimeout(r, 20))
  expect(win.document.getElementById("first-paint-repo")).toBeNull()

  // Consuming via prefetchingFetch returns the prefetched response once without calling `next`
  let fallbackCalls = 0
  const baseFetch = (async () => {
    fallbackCalls++
    return Response.json({ fallback: true })
  }) as typeof fetch
  expect(prefetchingFetch(baseFetch, undefined)).toBe(baseFetch)

  const wrapped = prefetchingFetch(baseFetch, handle)
  const role1 = await wrapped(new Request("https://smithers.test/api/repos/evmts/guillotine/role"))
  expect(await role1.json()).toEqual({ role: "admin", own: false, readable: true })
  expect(fallbackCalls).toBe(0)

  // Non-GET, unknown path, and second call all go straight to `next`
  await wrapped("https://smithers.test/api/repos/evmts/guillotine/home", { method: "POST" })
  await wrapped("https://smithers.test/api/other")
  const role2 = await wrapped("https://smithers.test/api/repos/evmts/guillotine/role")
  expect(await role2.json()).toEqual({ fallback: true })
  expect(fallbackCalls).toBe(3)

  // Revoke is idempotent
  handle.revoke()
  handle.revoke()
  expect(handle.take("/api/repos/evmts/guillotine/home")).toBeUndefined()
  await win.happyDOM.close()
})

test("startRepoPrefetch covers flat blocks, malformed home + root tree fallback, no MutationObserver, and role variations", async () => {
  const win = new Window({ url: "https://smithers.test/acme/demo" })
  win.document.body.innerHTML = '<div id="root"></div>'
  // Remove MutationObserver to cover the non-observer branch
  ;(win as unknown as { MutationObserver?: unknown }).MutationObserver = undefined

  const fakeFetch = (async (input: RequestInfo | URL) => {
    const u = String(input)
    if (u.endsWith("/role")) return Response.json({ role: "member", readable: false })
    if (u.endsWith("/home")) return Response.json({})
    if (u.endsWith("/about")) {
      return Response.json({
        name: "plainname",
        home: "{bad json",
        root: [{ name: "src", kind: "dir" }, { name: "README.md", kind: "file" }, {}],
      })
    }
    return new Response(null, { status: 404 })
  }) as typeof fetch

  const handle = startRepoPrefetch(hostOf(win, { fetch: fakeFetch }))!
  await new Promise((r) => setTimeout(r, 20))
  const text = win.document.getElementById("first-paint-repo")?.textContent ?? ""
  expect(text).toContain("acme / demo")
  expect(text).toContain("dirsrc")
  expect(text).toContain("fileREADME.md")
  handle.revoke()

  // Flat blocks + public role + missing about.name + empty home
  const win2 = new Window({ url: "https://smithers.test/acme/flat" })
  win2.document.body.innerHTML = '<div id="root"></div>'
  const handle2 = startRepoPrefetch(
    hostOf(win2, {
      fetch: (async (input: RequestInfo | URL) => {
        const u = String(input)
        if (u.endsWith("/role")) return Response.json({ public: true })
        if (u.endsWith("/about")) {
          return Response.json({
            home: JSON.stringify({ blocks: [{ type: "text", title: "Flat Block" }] }),
          })
        }
        return Response.json({})
      }) as typeof fetch,
    }),
  )!
  await new Promise((r) => setTimeout(r, 20))
  expect(win2.document.getElementById("first-paint-repo")?.textContent).toContain("Flat Block")
  handle2.revoke()

  // Home with neither sections nor blocks (empty object) and whitespace home
  const win3 = new Window({ url: "https://smithers.test/acme/empty" })
  win3.document.body.innerHTML = '<div id="root"></div>'
  const handle3 = startRepoPrefetch(
    hostOf(win3, {
      fetch: (async (input: RequestInfo | URL) => {
        const u = String(input)
        if (u.endsWith("/role")) return Response.json({ role: "maintainer", readable: true })
        if (u.endsWith("/about")) return Response.json({ home: JSON.stringify({}) })
        return Response.json({})
      }) as typeof fetch,
    }),
  )!
  await new Promise((r) => setTimeout(r, 20))
  expect(win3.document.getElementById("first-paint-repo")?.textContent).toContain("acme / empty")
  handle3.revoke()

  const win3b = new Window({ url: "https://smithers.test/acme/contrib" })
  win3b.document.body.innerHTML = '<div id="root"></div>'
  const handle3b = startRepoPrefetch(
    hostOf(win3b, {
      fetch: (async (input: RequestInfo | URL) => {
        const u = String(input)
        if (u.endsWith("/role")) return Response.json({ role: "contributor", readable: true })
        if (u.endsWith("/about")) return Response.json({ home: "   " })
        return Response.json({})
      }) as typeof fetch,
    }),
  )!
  await new Promise((r) => setTimeout(r, 20))
  expect(win3b.document.getElementById("first-paint-repo")?.textContent).toContain("acme / contrib")
  handle3b.revoke()

  await win.happyDOM.close()
  await win2.happyDOM.close()
  await win3.happyDOM.close()
  await win3b.happyDOM.close()
})

test("startRepoPrefetch respects locks, edge-public, React already mounted, unauthorized, failed fetches, wipe, storage, expiry and navigation", async () => {
  // 1. Wipe mark present or storage throws -> undefined
  const win1 = new Window({ url: "https://smithers.test/evmts/guillotine" })
  win1.localStorage.setItem(WIPE, "1")
  expect(startRepoPrefetch(hostOf(win1))).toBeUndefined()
  expect(
    startRepoPrefetch(
      hostOf(win1, {
        marks: {
          getItem: () => {
            throw new Error("blocked")
          },
        },
      }),
    ),
  ).toBeUndefined()
  expect(startRepoPrefetch(hostOf(new Window({ url: "https://smithers.test/app" })))).toBeUndefined()

  // 2. Web Lock acquired -> runs locked, and revoking releases lock; Web Lock rejected -> revokes cleanly
  const win2 = new Window({ url: "https://smithers.test/evmts/guillotine" })
  win2.document.body.innerHTML = '<div id="root"><main data-edge-first-paint="repo-public">Already painted</main></div>'
  let lockReleased = false
  let lockPromise!: Promise<void>
  const handleLocked = startRepoPrefetch(
    hostOf(win2, {
      locks: {
        request: (_name: string, _opts: LockOptions, cb: LockGrantedCallback<unknown>) => {
          lockPromise = Promise.resolve(cb({} as Lock)).then(() => {
            lockReleased = true
          })
          return lockPromise
        },
      } as unknown as Pick<LockManager, "request">,
      fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
    }),
  )!
  handleLocked.revoke()
  await lockPromise
  expect(lockReleased).toBe(true)

  // Web Lock callback sees revoked/marked before running
  const win2b = new Window({ url: "https://smithers.test/evmts/guillotine" })
  let markedNow = false
  let capturedCb!: () => Promise<void>
  const handleLate = startRepoPrefetch(
    hostOf(win2b, {
      marks: { getItem: () => (markedNow ? "1" : null) },
      locks: {
        request: (_name: string, _opts: LockOptions, cb: LockGrantedCallback<unknown>) => {
          capturedCb = async () => {
            await cb({} as Lock)
          }
          return Promise.resolve()
        },
      } as unknown as Pick<LockManager, "request">,
    }),
  )!
  markedNow = true
  await capturedCb()
  expect(handleLate.take("/api/repos/evmts/guillotine/role")).toBeUndefined()

  // Web Lock rejects -> handled via .catch(revoke)
  const win2c = new Window({ url: "https://smithers.test/evmts/guillotine" })
  const handleRejectedLock = startRepoPrefetch(
    hostOf(win2c, {
      locks: {
        request: () => Promise.reject(new Error("aborted")),
      } as unknown as Pick<LockManager, "request">,
    }),
  )!
  await new Promise((r) => setTimeout(r, 10))
  expect(handleRejectedLock.take("/api/repos/evmts/guillotine/role")).toBeUndefined()

  // 3. Unauthorized role, non-OK/throwing fetches, and prefetchingFetch fallback on rejected promise
  const win3 = new Window({ url: "https://smithers.test/evmts/guillotine" })
  win3.document.body.innerHTML = '<div id="root"></div>'
  const handleUnauth = startRepoPrefetch(
    hostOf(win3, {
      fetch: (async (input: RequestInfo | URL) => {
        const u = String(input)
        if (u.endsWith("/role")) return Response.json({ role: null, readable: false })
        if (u.endsWith("/about")) return Response.json({ name: "evmts/guillotine" })
        return Promise.reject(new Error("home failed"))
      }) as typeof fetch,
    }),
  )!
  await new Promise((r) => setTimeout(r, 20))
  expect(win3.document.getElementById("first-paint-repo")).toBeNull()
  let fallbackUsed = false
  const wrappedFail = prefetchingFetch(
    (async () => {
      fallbackUsed = true
      return new Response("ok")
    }) as typeof fetch,
    handleUnauth,
  )
  await wrappedFail("https://smithers.test/api/repos/evmts/guillotine/home")
  expect(fallbackUsed).toBe(true)
  handleUnauth.revoke()

  // 4. Failed /about and non-ok /role -> readJson returns undefined, nothing painted
  const win4 = new Window({ url: "https://smithers.test/evmts/guillotine" })
  win4.document.body.innerHTML = '<div id="root"></div>'
  const handleFail = startRepoPrefetch(
    hostOf(win4, {
      fetch: (async (input: RequestInfo | URL) => {
        const u = String(input)
        if (u.endsWith("/about")) throw new Error("network down")
        if (u.endsWith("/role")) return new Response("bad", { status: 500 })
        return new Response("not json", { status: 200 })
      }) as typeof fetch,
    }),
  )!
  await new Promise((r) => setTimeout(r, 20))
  expect(win4.document.getElementById("first-paint-repo")).toBeNull()
  handleFail.revoke()

  // 4c. Rejected /role promise is safely caught without unhandledrejection
  const win4c = new Window({ url: "https://smithers.test/evmts/guillotine" })
  win4c.document.body.innerHTML = '<div id="root"></div>'
  const handleRoleReject = startRepoPrefetch(
    hostOf(win4c, {
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/role")) throw new Error("role offline")
        return Response.json({ name: "evmts/guillotine" })
      }) as typeof fetch,
    }),
  )!
  await new Promise((r) => setTimeout(r, 20))
  expect(win4c.document.getElementById("first-paint-repo")).toBeNull()
  handleRoleReject.revoke()
  await win4c.happyDOM.close()

  // 5. Malformed JSON in /role -> caught in readJson
  const win4b = new Window({ url: "https://smithers.test/evmts/guillotine" })
  win4b.document.body.innerHTML = '<div id="root"></div>'
  const handleBadJson = startRepoPrefetch(
    hostOf(win4b, {
      fetch: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
    }),
  )!
  await new Promise((r) => setTimeout(r, 20))
  expect(win4b.document.getElementById("first-paint-repo")).toBeNull()
  handleBadJson.revoke()

  // 6. React already mounted before responses settle -> does not paint overlay
  const win5 = new Window({ url: "https://smithers.test/evmts/guillotine" })
  win5.document.body.innerHTML = '<div id="root"><main>Already mounted</main></div>'
  const handleMounted = startRepoPrefetch(
    hostOf(win5, {
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/role")) return Response.json({ readable: true })
        return Response.json({ name: "evmts/guillotine" })
      }) as typeof fetch,
    }),
  )!
  await new Promise((r) => setTimeout(r, 20))
  expect(win5.document.getElementById("first-paint-repo")).toBeNull()
  handleMounted.revoke()

  // 7. Pathname changed before responses settle -> revokes instead of painting
  const win6 = new Window({ url: "https://smithers.test/evmts/guillotine" })
  win6.document.body.innerHTML = '<div id="root"></div>'
  let resolveRole!: (r: Response) => void
  const handleNav = startRepoPrefetch(
    hostOf(win6, {
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/role")) return new Promise<Response>((r) => { resolveRole = r })
        return Response.json({ name: "evmts/guillotine" })
      }) as typeof fetch,
    }),
  )!
  win6.history.pushState({}, "", "/other/repo")
  resolveRole(Response.json({ readable: true }))
  await new Promise((r) => setTimeout(r, 20))
  expect(win6.document.getElementById("first-paint-repo")).toBeNull()
  expect(handleNav.take("/api/repos/evmts/guillotine/home")).toBeUndefined()

  // 8. Expiry before responses settle & storage event revoking (both WIPE key and null clear key, plus unrelated key)
  let clock = 1_000
  const win7 = new Window({ url: "https://smithers.test/evmts/guillotine" })
  win7.document.body.innerHTML = '<div id="root"></div>'
  let resolveRole7!: (r: Response) => void
  const handleExp = startRepoPrefetch(
    hostOf(win7, {
      now: () => clock,
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/role")) return new Promise<Response>((r) => { resolveRole7 = r })
        return Response.json({ name: "evmts/guillotine" })
      }) as typeof fetch,
    }),
  )!
  // Unrelated storage event does not revoke
  win7.dispatchEvent(new win7.StorageEvent("storage", { key: "other", newValue: "x" }))
  clock = 20_000
  resolveRole7(Response.json({ readable: true }))
  await new Promise((r) => setTimeout(r, 20))
  expect(win7.document.getElementById("first-paint-repo")).toBeNull()
  expect(handleExp.take("/api/repos/evmts/guillotine/home")).toBeUndefined()

  // Storage event with WIPE revokes
  const win8 = new Window({ url: "https://smithers.test/evmts/guillotine" })
  const handleStorage = startRepoPrefetch(hostOf(win8))!
  win8.dispatchEvent(new win8.StorageEvent("storage", { key: WIPE, newValue: "1" }))
  expect(handleStorage.take("/api/repos/evmts/guillotine/role")).toBeUndefined()

  // takeRepoPrefetch takes once
  const holder: Record<string, unknown> = { [REPO_PREFETCH_GLOBAL]: { take: () => undefined, revoke: () => {} } }
  expect(takeRepoPrefetch(holder)).toBeDefined()
  expect(takeRepoPrefetch(holder)).toBeUndefined()

  await Promise.all([
    win1.happyDOM.close(),
    win2.happyDOM.close(),
    win2b.happyDOM.close(),
    win2c.happyDOM.close(),
    win3.happyDOM.close(),
    win4.happyDOM.close(),
    win4b.happyDOM.close(),
    win5.happyDOM.close(),
    win6.happyDOM.close(),
    win7.happyDOM.close(),
    win8.happyDOM.close(),
  ])
})
