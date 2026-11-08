// Real HTTP, Web Locks, storage, DOM and observer. Failed clock/storage dependencies are Effect layers.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Window } from "happy-dom"
import { Clock, Context, Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/http"
import { afterAll, beforeAll, expect, test } from "vitest"
import { painted } from "../../worker/github/FirstPaint"
import { DATA_LOCK, WIPE } from "../wipe"
import { startShell, type EndRecord, type ShellHost } from "./shell"

class Environment extends Context.Service<Environment, {
  readonly now: Effect.Effect<number>
  readonly mark: Effect.Effect<string | null>
}>()("first-paint-test/Environment") {}

let server: Server
let origin: string
beforeAll(async () => {
  server = createServer((request, response) => {
    const answer = HttpServerResponse.toWeb(painted({
      viewer: null,
      serverNow: Date.now(),
      ...(request.url!.includes("short") ? { expiresAt: Date.now() + 10_000 } : {}),
      list: [{ number: 7, title: "Seven", state: "open", author: null }],
    }))
    void answer.arrayBuffer().then((body) => {
      response.writeHead(answer.status, Object.fromEntries(answer.headers))
      response.end(new Uint8Array(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const open = (short = false) => {
  const win = new Window({ url: `${origin}/acme/${short ? "short" : "app"}/issues` })
  const records: Array<{ name: string; detail: EndRecord | undefined }> = []
  const live = { now: Clock.currentTimeMillis, mark: Effect.sync(() => win.localStorage.getItem(WIPE)) }
  let environment = Layer.succeed(Environment, live)
  const use = <A>(read: (env: Environment["Service"]) => Effect.Effect<A>) =>
    Effect.runSync(Effect.flatMap(Environment, read).pipe(Effect.provide(environment)))
  let paintedReady!: () => void
  let endedReady!: () => void
  const ready = new Promise<void>((resolve) => { paintedReady = resolve })
  const ended = new Promise<void>((resolve) => { endedReady = resolve })
  const shell = startShell({
    window: win as unknown as ShellHost["window"],
    document: win.document as unknown as Document,
    locks: navigator.locks,
    fetch: (input, init) => fetch(new URL(String(input), origin), init),
    now: () => use((env) => env.now),
    marks: { getItem: () => use((env) => env.mark) },
    channel: (name) => new BroadcastChannel(name),
    observe: (callback) => {
      const observer = new win.MutationObserver(callback)
      observer.observe(win.document.documentElement, { childList: true, subtree: true, attributes: true })
      return observer
    },
    mark: (name, detail) => {
      records.push({ name, detail })
      if (name === "smithers.first_paint.painted") paintedReady()
      if (detail !== undefined) endedReady()
    },
  })!
  return {
    win, shell, records, ready, ended,
    fault: (service: Partial<typeof live>) => { environment = Layer.succeed(Environment, { ...live, ...service }) },
    search: () => {
      const input = win.document.querySelector("input")!
      input.value = "#7"
      input.dispatchEvent(new win.Event("input"))
    },
    outcomes: () => records.filter((record) => record.detail !== undefined),
    close: async () => { shell.revoke(); await win.happyDOM.close() },
  }
}

test("a background search hands over without stealing focus, and records one connected outcome", async () => {
  const page = open()
  try {
    await page.ready
    const root = page.win.document.createElement("div")
    root.id = "root"
    root.innerHTML = '<main data-first-paint="settled"><input aria-label="Search issues"></main>'
    page.win.document.body.append(root)
    await page.ended
    expect(page.win.document.activeElement).toBe(page.win.document.body)
    expect(page.outcomes()).toEqual([{ name: "smithers.first_paint.handed_over", detail: { previous: "painted", trigger: "dom", connected: true } }])
    expect(page.win.document.getElementById("first-paint")).toBeNull()
  } finally { await page.close() }
})

test("a storage revocation fences a pending search answer with one outcome", async () => {
  const page = open()
  try {
    await page.ready
    page.search()
    page.win.localStorage.setItem(WIPE, "1")
    page.shell.showSearch!("acme", "app", "#7", [])
    expect(page.outcomes()).toEqual([{ name: "smithers.first_paint.mark", detail: { previous: "painted", trigger: "storage", connected: true } }])
    expect(page.win.document.getElementById("first-paint")).toBeNull()
  } finally { await page.close() }
})

test.each([false, true])("a late search answer rechecks its deadline (session expiry: %s)", async (short) => {
  const page = open(short)
  try {
    await page.ready
    page.search()
    // A faulty clock service advances while DOM timers have not fired, as after suspension.
    page.fault({ now: Effect.succeed(Date.now() + 60_000) })
    page.shell.showSearch!("acme", short ? "short" : "app", "#7", [])
    expect(page.outcomes()).toEqual([{ name: `smithers.first_paint.${short ? "deadline" : "hand_over_timeout"}`, detail: { previous: "painted", trigger: "search", connected: true } }])
    expect(page.win.document.getElementById("first-paint")).toBeNull()
  } finally { await page.close() }
})

test("a page replacing the list cannot receive late rows or a false search-answer mark", async () => {
  const page = open()
  try {
    await page.ready
    page.search()
    page.win.document.querySelector("#first-paint ul")!.remove()
    page.shell.showSearch!("acme", "app", "#7", [{ number: 7, title: "Seven", state: "open", author: null }])
    expect(page.records.some((record) => record.name === "smithers.first_paint.search_answer")).toBe(false)
    page.shell.routed("/acme/app/issues/7", "")
    expect(page.outcomes()).toEqual([{ name: "smithers.first_paint.navigated", detail: { previous: "painted", trigger: "router", connected: true } }])
  } finally { await page.close() }
})

test("a mark becoming visible after the lock grant revokes adoption before private data can paint", async () => {
  let release!: () => void
  let acquired!: () => void
  const held = new Promise<void>((resolve) => { acquired = resolve })
  const lock = navigator.locks.request(DATA_LOCK, () => new Promise<void>((resolve) => { release = resolve; acquired() }))
  await held
  const page = open()
  try {
    // A faulty storage service reports revocation at the resumed adoption boundary.
    page.fault({ mark: Effect.sync(() => page.records.some((record) => record.name === "smithers.first_paint.hand_over_ready") ? "1" : null) })
    const adoption = page.shell.handOver()
    release()
    expect(await adoption).toBeUndefined()
    expect(page.outcomes()).toEqual([{ name: "smithers.first_paint.mark", detail: { previous: "pending", trigger: "storage", connected: false } }])
    expect(page.win.document.getElementById("first-paint")).toBeNull()
  } finally { release(); await lock; await page.close() }
})
