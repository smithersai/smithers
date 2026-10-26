// What the PWA keeps and how the app's pages are framed (src/pwa.ts, docs/features/web-pages.md#the-app-around-a-frame).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  DOCS_SITE,
  DOCS_SITE_PATHS,
  FRAME_POLICY,
  PAGE_HEADERS,
  shellCaches,
  watchInstalls,
  watchUpdates,
  type UpdateTrigger,
  type WorkerState,
} from "./pwa"

const APP = "https://app.smithers.sh"

const request = (url: string, destination: string, method = "GET") => ({
  url: new URL(url),
  sameOrigin: new URL(url).origin === APP,
  request: { method, destination },
})

describe("the service worker's shell", () => {
  test("keeps the app's own modules and pages, network first", () => {
    expect(shellCaches(request(`${APP}/src/main.tsx`, "script"))).toBe(true)
    expect(shellCaches(request(`${APP}/app`, "document"))).toBe(true)
  })

  test("never keeps an embedded page, the API, another origin or a write", () => {
    expect(shellCaches(request("https://example.com/", "iframe"))).toBe(false)
    expect(shellCaches(request(`${APP}/app`, "iframe"))).toBe(false)
    expect(shellCaches(request("https://example.com/app.js", "script"))).toBe(false)
    expect(shellCaches(request(`${APP}/api/shapes/views`, ""))).toBe(false)
    expect(shellCaches(request(`${APP}/src/main.tsx`, "script", "POST"))).toBe(false)
  })
})

describe("the docs site's paths", () => {
  // One path under each route: a folder's own page, a page inside it, or the file itself.
  const served = DOCS_SITE_PATHS.map((path) => path.replace(/\/\*$/, "/page/").replace(/\*$/, ""))

  test("are never the app's: its service worker neither keeps nor answers them", () => {
    for (const path of served) {
      expect(DOCS_SITE.test(path)).toBe(true)
      expect(DOCS_SITE.test(`${path}?q=1`)).toBe(true)
      expect(shellCaches(request(`${APP}${path}`, "document"))).toBe(false)
    }
    expect(DOCS_SITE.test("/docs")).toBe(true)
    expect(DOCS_SITE.test("/docs/installation/")).toBe(true)
    expect(DOCS_SITE.test("/changelogs/1.0.0-rc.0/")).toBe(true)
  })

  test("leave the app its own pages, including repositories whose owner starts like one of them", () => {
    for (const path of ["/", "/app", "/app/flows", "/smithersai/smithers", "/docsify/docsify", "/demos/x", "/llms/x", "/assets/index.js"]) {
      expect(DOCS_SITE.test(path)).toBe(false)
      expect(shellCaches(request(`${APP}${path}`, "document"))).toBe(true)
    }
  })

  test("are written out in the shell's matcher exactly as the list makes them, since Workbox copies its source", () => {
    expect(String(shellCaches)).toContain(`/${DOCS_SITE.source}/.test(url.pathname)`)
  })
})

describe("framing", () => {
  test("the app's pages refuse every frame, in development and on Cloudflare alike", () => {
    expect(PAGE_HEADERS).toEqual({ "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" })
    const served = readFileSync(join(import.meta.dirname, "..", "public", "_headers"), "utf8")
    expect(served).toMatch(/^\/\*$/m)
    for (const [name, value] of Object.entries(PAGE_HEADERS)) expect(served).toContain(`  ${name}: ${value}`)
  })

  test("the app frames only https: pages", () => {
    expect(FRAME_POLICY).toBe("frame-src https:")
  })
})


describe("open tabs check for releases", () => {
  test("visibility, focus and route completion check the registered worker; failures recover on the next signal", async () => {
    const listeners = new Map<UpdateTrigger, () => void>()
    const records: unknown[] = []
    let visible = true
    let calls = 0
    let finish!: () => void
    let fail = false
    const stop = watchUpdates({ update: async () => {
      calls++
      if (fail) throw new Error("offline")
      await new Promise<void>((resolve) => { finish = resolve })
    } }, {
      visible: () => visible,
      listen: (trigger, check) => { listeners.set(trigger, check); return () => { listeners.delete(trigger) } },
      record: (trigger, outcome) => records.push([trigger, outcome]),
    })
    const signal = (trigger: UpdateTrigger) => listeners.get(trigger)!()
    visible = false
    signal("visible")
    expect(calls).toBe(0)
    visible = true
    for (const trigger of ["visible", "focus", "navigation"] as const) {
      signal(trigger)
      signal(trigger)
      finish()
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect(calls).toBe(3)
    fail = true
    signal("focus")
    await new Promise((resolve) => setImmediate(resolve))
    fail = false
    signal("navigation")
    finish()
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls).toBe(5)
    expect(records).toEqual([
      ["visible", "hidden"],
      ["visible", "busy"], ["visible", "checked"],
      ["focus", "busy"], ["focus", "checked"],
      ["navigation", "busy"], ["navigation", "checked"],
      ["focus", "failed"], ["navigation", "checked"],
    ])
    stop()
    expect(listeners.size).toBe(0)
  })
})

describe("a service worker's install", () => {
  /** A worker whose state the test moves, as the browser does, telling its listeners. */
  const worker = () => {
    const listeners: Array<() => void> = []
    const self = {
      state: "installing",
      addEventListener: (_type: "statechange", listener: () => void) => void listeners.push(listener),
      to: (state: string) => {
        self.state = state
        for (const listener of listeners) listener()
      },
    }
    return self
  }

  test("that fails, now or after an update starts, is reported once each; one that installed and was replaced isn't", () => {
    const failures: Array<string> = []
    const first = worker()
    const registration = {
      installing: first as WorkerState | null,
      updates: [] as Array<() => void>,
      addEventListener: (_type: "updatefound", listener: () => void) => void registration.updates.push(listener),
    }
    watchInstalls(registration, () => failures.push("failed"))
    first.to("installed")
    first.to("activated")
    first.to("redundant")
    expect(failures).toEqual([])
    const second = worker()
    registration.installing = second
    for (const update of registration.updates) update()
    second.to("redundant")
    expect(failures).toEqual(["failed"])
    // An update that found no installing worker watches nothing.
    registration.installing = null
    for (const update of registration.updates) update()
    expect(failures).toEqual(["failed"])
  })
})
