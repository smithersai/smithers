// @vitest-environment happy-dom
// The first paint's shell (src/firstPaint/shell.ts, devpriv FINAL §3.10) against a scripted browser: its Web Lock, its
// clock, its storage mark, its wipe channel and its read are fakes; its DOM is happy-dom's.
import { afterEach, describe, expect, test } from "vitest"
import { DATA_LOCK, pageWipe, WIPE } from "../wipe"
import {
  answerOf,
  deadlineOf,
  FIRST_PAINT_NODE,
  HAND_OVER_WITHIN_MS,
  PLACED_ATTRIBUTE,
  requestOf,
  routeOf,
  sameViewer,
  SETTLED_ATTRIBUTE,
  SLOT_ATTRIBUTE,
  type ShellHost,
  startShell,
} from "./shell"

const ISSUE = { number: 7, title: "<b>Seven</b>", state: "open", author: "ada" }

/** A scripted browser for one shell. */
const browser = (options: { readonly path?: string; readonly search?: string; readonly mark?: string | "throws" } = {}) => {
  let now = 1_000
  let visibility: DocumentVisibilityState = "visible"
  let mark = options.mark
  const timers: Array<{ at: number; run: () => void; id: number }> = []
  let nextTimer = 1
  const windowEvents = new EventTarget()
  const documentEvents = new EventTarget()
  const location = { pathname: options.path ?? "/acme/app/issues/7", search: options.search ?? "" }
  // The lock: one pending request at a time, granted when the test says, held until its callback's promise settles.
  const lock = { asked: 0, held: false, released: false, grant: () => {}, mode: "", name: "", aborted: false }
  // The read: answered when the test says.
  const read: { url?: string; init?: RequestInit; answer: (status: number, body?: unknown) => void; fail: () => void } = {
    answer: () => {},
    fail: () => {},
  }
  const channels: Array<{ onmessage: ((event: MessageEvent) => void) | null; closed: boolean }> = []
  const observers: Array<{ callback: () => void; connected: boolean }> = []
  const marks: Array<string> = []
  const host: ShellHost = {
    window: {
      location,
      addEventListener: windowEvents.addEventListener.bind(windowEvents) as never,
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents) as never,
      setTimeout: ((run: () => void, ms: number) => {
        const id = nextTimer++
        timers.push({ at: now + ms, run, id })
        return id
      }) as never,
      clearTimeout: ((id: number) => {
        const at = timers.findIndex((timer) => timer.id === id)
        if (at >= 0) timers.splice(at, 1)
      }) as never,
    },
    document: {
      createElement: document.createElement.bind(document) as never,
      body: document.body,
      get visibilityState() {
        return visibility
      },
      addEventListener: documentEvents.addEventListener.bind(documentEvents) as never,
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents) as never,
      querySelector: document.querySelector.bind(document) as never,
    },
    locks: {
      request: ((name: string, opts: LockOptions, callback: () => Promise<void>) => {
        lock.asked++
        lock.name = name
        lock.mode = opts.mode ?? ""
        return new Promise<void>((resolve, reject) => {
          opts.signal?.addEventListener("abort", () => {
            if (lock.held) return
            lock.aborted = true
            reject(new DOMException("aborted", "AbortError"))
          })
          lock.grant = () => {
            lock.held = true
            void callback().then(() => {
              lock.held = false
              lock.released = true
              resolve()
            })
          }
        })
      }) as never,
    },
    fetch: ((url: string, init: RequestInit) => {
      read.url = url
      read.init = init
      return new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        read.answer = (status, body) =>
          resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }))
        read.fail = () => reject(new TypeError("network"))
      })
    }) as never,
    now: () => now,
    marks: {
      getItem: (key: string) => {
        expect(key).toBe(WIPE)
        if (mark === "throws") throw new Error("blocked")
        return mark ?? null
      },
    },
    channel: (name) => {
      expect(name).toBe(WIPE)
      const channel = { onmessage: null as ((event: MessageEvent) => void) | null, closed: false, close: () => void (channel.closed = true) }
      channels.push(channel)
      return channel
    },
    observe: (callback) => {
      const observer = { callback, connected: true }
      observers.push(observer)
      return { disconnect: () => void (observer.connected = false) }
    },
    mark: (name) => void marks.push(name),
  }
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  return {
    host,
    lock,
    read,
    marks,
    channels,
    location,
    setMark: (value: string | undefined | "throws") => void (mark = value),
    setVisibility: (value: DocumentVisibilityState) => {
      visibility = value
      documentEvents.dispatchEvent(new Event("visibilitychange"))
    },
    lifecycle: (kind: "freeze" | "resume") => documentEvents.dispatchEvent(new Event(kind)),
    /** Moves the clock without running timers, as a hidden page's timers may not run. */
    jump: (ms: number) => void (now += ms),
    advance: (ms: number) => {
      now += ms
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > now) continue
        timers.splice(timers.indexOf(timer), 1)
        timer.run()
      }
    },
    dispatch: (event: Event) => windowEvents.dispatchEvent(event),
    mutate: () => {
      for (const observer of observers) if (observer.connected) observer.callback()
    },
    settle,
    node: () => document.getElementById(FIRST_PAINT_NODE),
    /** Grants the hold, answers the read with `body`, and lets both settle. */
    paint: async function (body: unknown, status = 200) {
      this.lock.grant()
      await settle()
      this.read.answer(status, body)
      await settle()
      await settle()
    },
  }
}

const painted = (extra: object = {}) => ({ viewer: "person-1", expiresAt: 1_000 + 3_600_000, serverNow: 1_000, issue: ISSUE, ...extra })

afterEach(() => {
  document.body.replaceChildren()
  document.getElementById("root")?.remove()
})

describe("which routes paint", () => {
  test.each([
    ["/acme/app/issues/7", "", { kind: "issue", owner: "acme", name: "app", number: 7 }],
    ["/acme/app/issues/7/", "", { kind: "issue", owner: "acme", name: "app", number: 7 }],
    ["/acme/app/issues/7", "?tab=x", { kind: "issue", owner: "acme", name: "app", number: 7 }],
    ["/acme/app/issues", "", { kind: "list", owner: "acme", name: "app" }],
    ["/acme/app/issues", "?q=bug", undefined],
    ["/acme/app/issues/new", "", undefined],
    ["/acme/app/issues/0", "", undefined],
    ["/acme/app/pulls", "", undefined],
    ["/acme/a%20b/issues", "", undefined],
    ["/app", "", undefined],
  ])("%s%s", (path, search, expected) => {
    expect(routeOf(path, search)).toEqual(expected)
  })

  test("each form's read", () => {
    expect(requestOf({ kind: "issue", owner: "acme", name: "a.pp", number: 7 })).toBe("/api/repos/acme/a.pp/first-paint?issue=7")
    expect(requestOf({ kind: "list", owner: "acme", name: "app" })).toBe("/api/repos/acme/app/first-paint?list=all")
  })
})

describe("what an answer must be", () => {
  const issue = { kind: "issue", owner: "acme", name: "app", number: 7 } as const
  const list = { kind: "list", owner: "acme", name: "app" } as const
  test.each([
    ["an issue", painted(), issue, true],
    ["a public issue", painted({ viewer: null, expiresAt: undefined }), issue, true],
    ["another issue", painted({ issue: { ...ISSUE, number: 8 } }), issue, false],
    ["no issue", painted({ issue: undefined }), issue, false],
    ["an issue with a bad title", painted({ issue: { ...ISSUE, title: 7 } }), issue, false],
    ["an issue with a bad author", painted({ issue: { ...ISSUE, author: 7 } }), issue, false],
    ["an issue with no author", painted({ issue: { ...ISSUE, author: null } }), issue, true],
    ["a list", painted({ issue: undefined, list: [ISSUE] }), list, true],
    ["a list with a bad row", painted({ issue: undefined, list: [ISSUE, null] }), list, false],
    ["no list", painted(), list, false],
    ["a bad viewer", painted({ viewer: 7 }), issue, false],
    ["a bad expiry", painted({ expiresAt: "soon" }), issue, false],
    ["no clock", painted({ serverNow: undefined }), issue, false],
    ["nothing", null, issue, false],
  ] as const)("%s", (_name, body, route, ok) => {
    expect(answerOf(body, route) !== undefined).toBe(ok)
  })

  test("its deadline counts from when it was sent, in the server's time left", () => {
    expect(deadlineOf({ viewer: null, serverNow: 50_000, expiresAt: 60_000 }, 1_000)).toBe(11_000)
    expect(deadlineOf({ viewer: null, serverNow: 50_000 }, 1_000)).toBe(Infinity)
  })

  test("a person's paint stays only for them; a public one for anyone", () => {
    expect(sameViewer("p", { signedIn: true, personId: "p" })).toBe(true)
    expect(sameViewer("p", { signedIn: true, personId: "q" })).toBe(false)
    expect(sameViewer("p", { signedIn: false })).toBe(false)
    expect(sameViewer(null, { signedIn: false })).toBe(true)
  })
})

describe("the shell", () => {
  test("another route, or a marked or unreadable device, asks for nothing", () => {
    for (const options of [{ path: "/app" }, { mark: "1" }, { mark: "throws" as const }]) {
      const b = browser(options)
      expect(startShell(b.host)).toBeUndefined()
      expect(b.lock.asked).toBe(0)
    }
  })

  test("holds smithers-data, shared, before it reads; paints text only; hands the hold to the page", async () => {
    const b = browser()
    const shell = startShell(b.host)!
    expect([b.lock.name, b.lock.mode]).toEqual([DATA_LOCK, "shared"])
    await b.settle()
    expect(b.read.url).toBeUndefined()
    await b.paint(painted())
    expect(b.read.url).toBe("/api/repos/acme/app/first-paint?issue=7")
    expect(b.read.init).toMatchObject({ credentials: "same-origin", cache: "no-store" })
    const heading = b.node()!.querySelector("h1")!
    expect(heading.textContent).toBe("<b>Seven</b> #7")
    expect(heading.querySelector("b")).toBeNull()
    expect(b.node()!.querySelector(".first-paint-meta")!.textContent).toBe("Open · ada")
    expect(shell.outcome()).toBe("painted")
    expect(b.marks).toEqual(["smithers.first_paint.painted"])
    // The page adopts the hold: no gap, and the shell's end never lets go of it.
    const release = shell.handOver()!
    shell.revoke()
    await b.settle()
    expect([b.node(), b.lock.held]).toEqual([null, true])
    release()
    await b.settle()
    expect(b.lock.released).toBe(true)
    expect(shell.handOver()).toBeUndefined()
  })

  test("a closed issue with no author, and a list's rows as links", async () => {
    const issue = browser()
    startShell(issue.host)
    await issue.paint(painted({ issue: { ...ISSUE, state: "closed", author: null } }))
    expect(issue.node()!.querySelector(".first-paint-meta")!.textContent).toBe("Closed")
    document.body.replaceChildren()
    const list = browser({ path: "/acme/app/issues" })
    startShell(list.host)
    await list.paint(painted({ issue: undefined, list: [ISSUE, { ...ISSUE, number: 9, title: "Nine" }] }))
    expect([...list.node()!.querySelectorAll("li a")].map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
      ["/acme/app/issues/7", "<b>Seven</b>"],
      ["/acme/app/issues/9", "Nine"],
    ])
  })

  test("goes once the page shows itself, or the route moves on", async () => {
    const b = browser()
    const shell = startShell(b.host)!
    await b.paint(painted())
    const root = document.createElement("div")
    root.id = "root"
    document.body.append(root)
    b.mutate()
    expect(b.node()).not.toBeNull()
    root.innerHTML = `<main ${SETTLED_ATTRIBUTE}="settled"></main>`
    b.mutate()
    expect([b.node(), shell.outcome()]).toEqual([null, "handed_over"])
    await b.settle()
    expect(b.lock.held).toBe(false)
    root.remove()

    const moved = browser()
    const other = startShell(moved.host)!
    await moved.paint(painted())
    moved.location.pathname = "/acme/app/pulls"
    moved.mutate()
    expect(other.outcome()).toBe("navigated")
  })

  test.each([
    ["a wipe message", (b: ReturnType<typeof browser>) => b.channels[0]!.onmessage!(new MessageEvent("message", { data: "wipe" })), "wipe"],
    ["the mark set", (b: ReturnType<typeof browser>) => b.dispatch(Object.assign(new Event("storage"), { key: WIPE, newValue: "1" })), "mark"],
    ["storage cleared", (b: ReturnType<typeof browser>) => b.dispatch(Object.assign(new Event("storage"), { key: null, newValue: null })), "mark"],
    ["pagehide", (b: ReturnType<typeof browser>) => b.dispatch(new Event("pagehide")), "pagehide"],
    ["the session's deadline", (b: ReturnType<typeof browser>) => b.advance(10_000), "deadline"],
    ["no hand-over in time", (b: ReturnType<typeof browser>) => b.advance(HAND_OVER_WITHIN_MS), "hand_over_timeout", 3_600_000],
    ["another person's session", (b: ReturnType<typeof browser>) => b.host && shellOf(b).verify({ signedIn: true, personId: "person-2" }), "person_mismatch"],
    ["no session", (b: ReturnType<typeof browser>) => shellOf(b).verify({ signedIn: false }), "person_mismatch"],
  ])("%s revokes: the node, the answer and the hold go", async (_name, act, why, lifetime = 10_000) => {
    const b = browser()
    shells.set(b, startShell(b.host)!)
    await b.paint(painted({ expiresAt: 1_000 + lifetime }))
    expect(b.node()).not.toBeNull()
    act(b)
    await b.settle()
    expect([b.node(), shellOf(b).outcome(), b.lock.held, b.channels[0]!.closed]).toEqual([null, why, false, true])
    expect(b.marks.at(-1)).toBe(`smithers.first_paint.${why}`)
  })

  test("revoked as its answer arrives, it paints nothing; a second revocation changes nothing", async () => {
    const b = browser()
    const shell = startShell(b.host)!
    b.lock.grant()
    await b.settle()
    b.read.answer(200, painted())
    shell.revoke()
    shell.revoke("wipe")
    await b.settle()
    await b.settle()
    expect([b.node(), shell.outcome(), b.marks]).toEqual([null, "revoked", ["smithers.first_paint.revoked"]])
  })

  test("another key's storage change, and the same person's session, keep it", async () => {
    const b = browser()
    const shell = startShell(b.host)!
    await b.paint(painted())
    b.dispatch(Object.assign(new Event("storage"), { key: "other", newValue: "1" }))
    shell.verify({ signedIn: true, personId: "person-1" })
    expect(shell.outcome()).toBe("painted")
  })

  test("a session answered first decides whether a later answer may paint", async () => {
    const b = browser()
    const shell = startShell(b.host)!
    shell.verify({ signedIn: true, personId: "person-2" })
    await b.paint(painted())
    expect([b.node(), shell.outcome()]).toEqual([null, "person_mismatch"])
  })

  test("a hidden page hides the node; shown again, it checks the deadline and the mark first", async () => {
    const b = browser()
    startShell(b.host)
    await b.paint(painted({ expiresAt: 1_000 + 10_000 }))
    b.setVisibility("hidden")
    expect(b.node()!.hidden).toBe(true)
    b.setVisibility("visible")
    expect(b.node()!.hidden).toBe(false)
    b.setVisibility("hidden")
    b.setMark("1")
    b.setVisibility("visible")
    expect(b.node()).toBeNull()

    const late = browser()
    const shell = startShell(late.host)!
    await late.paint(painted({ expiresAt: 1_000 + 10_000 }))
    late.setVisibility("hidden")
    // Timers of a hidden page may not fire; showing it again checks the clock itself.
    late.jump(19_000)
    late.setVisibility("visible")
    expect(shell.outcome()).toBe("deadline")
  })

  describe("it never covers what a person can act on", () => {
    const mount = (html: string) => {
      const root = document.getElementById("root") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "root" }))
      root.innerHTML = html
      return root
    }
    const placed = (b: ReturnType<typeof browser>) => b.node()!.hasAttribute(PLACED_ATTRIBUTE)

    test("over the empty page; once the app renders anything to act on, in the page's flow after it", async () => {
      for (const actionable of ["<main></main>", "<button>x</button>", "<input />", "<a href='/'>x</a>"]) {
        document.body.replaceChildren()
        const root = mount("<div></div>")
        const b = browser()
        const shell = startShell(b.host)!
        await b.paint(painted())
        expect(placed(b)).toBe(false)
        b.mutate()
        expect(placed(b)).toBe(false)
        root.innerHTML = actionable
        b.mutate()
        expect(placed(b)).toBe(true)
        expect(root.compareDocumentPosition(b.node()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        // Placed once: it stays there, and it still goes on a revocation.
        const parent = b.node()!.parentNode
        b.mutate()
        expect(b.node()!.parentNode).toBe(parent)
        shell.revoke()
        expect(b.node()).toBeNull()
      }
    })

    test("an answer that arrives after the app rendered is in its flow from the start", async () => {
      const root = mount(`<main><div ${SLOT_ATTRIBUTE}></div></main>`)
      const b = browser()
      startShell(b.host)
      await b.paint(painted())
      expect(placed(b)).toBe(true)
      expect(root.querySelector(`[${SLOT_ATTRIBUTE}]`)!.contains(b.node())).toBe(true)
    })

    test("sits in the page's slot, follows a new slot, and goes when the page takes the slot away", async () => {
      const root = mount("")
      const b = browser()
      const shell = startShell(b.host)!
      await b.paint(painted())
      root.innerHTML = `<main id="pending"><div ${SLOT_ATTRIBUTE}></div></main>`
      b.mutate()
      expect(root.querySelector("#pending [" + SLOT_ATTRIBUTE + "]")!.contains(b.node())).toBe(true)
      const node = b.node()!
      b.mutate()
      expect(node.isConnected).toBe(true)
      // The route's page replaces the pending one: the paint moves with it, detached in between.
      root.innerHTML = `<main id="page"><div ${SLOT_ATTRIBUTE}></div></main>`
      expect(node.isConnected).toBe(false)
      b.mutate()
      expect(root.querySelector("#page [" + SLOT_ATTRIBUTE + "]")!.contains(b.node())).toBe(true)
      expect(shell.outcome()).toBe("painted")
      // The page's own rows replace the slot: the paint is over, and its answer with it.
      root.innerHTML = `<main id="page"><ul><li>row</li></ul></main>`
      b.mutate()
      expect([b.node(), shell.outcome()]).toEqual([null, "handed_over"])
      await b.settle()
      expect(b.lock.held).toBe(false)
    })
  })

  test("the router moving to another path or search ends it, with no DOM change; back or forward too", async () => {
    const same = browser()
    const shell = startShell(same.host)!
    await same.paint(painted())
    shell.routed("/acme/app/issues/7", "")
    expect(shell.outcome()).toBe("painted")
    shell.routed("/acme/app/issues/8", "")
    expect([same.node(), shell.outcome()]).toEqual([null, "navigated"])

    // The router's first replace: the same issue, slash and search aside, keeps it.
    const canonical = browser({ path: "/acme/app/issues/7/", search: "?x=1" })
    const kept = startShell(canonical.host)!
    await canonical.paint(painted())
    kept.routed("/acme/app/issues/7", "?x=1")
    kept.routed("/acme/app/issues/7", "")
    expect(kept.outcome()).toBe("painted")
    kept.routed("/acme/app/issues/70", "")
    expect(kept.outcome()).toBe("navigated")
    document.body.replaceChildren()

    // A list: the same path, slash aside, keeps it; any search filters it away.
    const list = () => painted({ issue: undefined, list: [ISSUE] })
    const searched = browser({ path: "/acme/app/issues/" })
    const other = startShell(searched.host)!
    await searched.paint(list())
    other.routed("/acme/app/issues", "")
    expect(other.outcome()).toBe("painted")
    other.routed("/acme/app/issues", "?q=x")
    expect(other.outcome()).toBe("navigated")

    const back = browser()
    const third = startShell(back.host)!
    await back.paint(painted())
    back.dispatch(new Event("popstate"))
    expect(third.outcome()).toBe("painted")
    back.location.pathname = "/acme/app/issues/8"
    back.dispatch(new Event("popstate"))
    expect([back.node(), third.outcome()]).toEqual([null, "navigated"])
  })

  test("frozen, the node hides; resumed past the hand-over cap, it goes", async () => {
    const b = browser()
    const shell = startShell(b.host)!
    await b.paint(painted())
    b.lifecycle("freeze")
    expect(b.node()!.hidden).toBe(true)
    b.lifecycle("resume")
    expect(b.node()!.hidden).toBe(false)
    b.lifecycle("freeze")
    b.jump(HAND_OVER_WITHIN_MS)
    b.lifecycle("resume")
    expect([b.node(), shell.outcome()]).toEqual([null, "hand_over_timeout"])
    // Resumed while hidden, nothing shows; with no node, nothing happens.
    const hidden = browser()
    startShell(hidden.host)
    await hidden.paint(painted())
    hidden.setVisibility("hidden")
    hidden.lifecycle("resume")
    expect(hidden.node()!.hidden).toBe(true)
    document.body.replaceChildren()
    const none = browser()
    startShell(none.host)
    none.lifecycle("freeze")
    none.lifecycle("resume")
    expect(none.node()).toBeNull()
  })

  test("an answer that arrives after the app showed the page, or after the route moved on, never paints", async () => {
    const root = document.createElement("div")
    root.id = "root"
    root.innerHTML = `<main ${SETTLED_ATTRIBUTE}="settled"></main>`
    document.body.append(root)
    const settled = browser()
    const shell = startShell(settled.host)!
    await settled.paint(painted())
    expect([settled.node(), shell.outcome()]).toEqual([null, "handed_over"])
    root.remove()

    for (const move of [{ pathname: "/acme/app/pulls" }, { search: "?q=x" }]) {
      const moved = browser({ path: "/acme/app/issues" })
      const other = startShell(moved.host)!
      Object.assign(moved.location, move)
      await moved.paint(painted({ issue: undefined, list: [ISSUE] }))
      expect([moved.node(), other.outcome()]).toEqual([null, "navigated"])
    }
  })

  test("the page's release of an adopted hold ends the paint first, and a later answer never paints", async () => {
    const shown = browser()
    const shell = startShell(shown.host)!
    await shown.paint(painted())
    // The real composition: the app's PageWipe adopts the shell's hold and lets go of it when the page closes.
    const wipe = pageWipe({
      locks: shown.host.locks,
      marks: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      directory: () => Promise.reject(new Error("never read")),
      indexedDB: { deleteDatabase: () => { throw new Error("never deleted") } },
      channel: () => ({ postMessage: () => {}, close: () => {}, onmessage: null }),
      reload: () => {},
    }, { engine: "engine", outbox: "outbox" })
    expect(await wipe.open(shell.handOver())).toBe(true)
    expect(shown.lock.asked).toBe(1)
    wipe.close()
    expect([shown.node(), shell.outcome()]).toEqual([null, "released"])
    await shown.settle()
    expect(shown.lock.released).toBe(true)

    const reading = browser()
    const pending = startShell(reading.host)!
    reading.lock.grant()
    await reading.settle()
    pending.handOver()!()
    reading.read.answer(200, painted())
    await reading.settle()
    await reading.settle()
    expect([reading.node(), pending.outcome(), reading.lock.held]).toEqual([null, "released", false])
  })

  test("an answer that arrives hidden paints hidden", async () => {
    const b = browser()
    startShell(b.host)
    b.setVisibility("hidden")
    await b.paint(painted())
    expect(b.node()!.hidden).toBe(true)
  })

  test.each([
    ["a 204", 204, undefined, "none"],
    ["an answer for another issue", 200, painted({ issue: { ...ISSUE, number: 8 } }), "none"],
    ["an answer already past its deadline", 200, painted({ expiresAt: 900 }), "deadline"],
  ])("%s paints nothing and lets go", async (_name, status, body, why) => {
    const b = browser()
    const shell = startShell(b.host)!
    await b.paint(body, status)
    expect([b.node(), shell.outcome(), b.lock.held]).toEqual([null, why, false])
    expect(shell.handOver()).toBeUndefined()
  })

  test("a failed read, or one past its wait, paints nothing", async () => {
    const failed = browser()
    const shell = startShell(failed.host)!
    failed.lock.grant()
    await failed.settle()
    failed.read.fail()
    await failed.settle()
    expect([shell.outcome(), failed.lock.held]).toEqual(["none", false])

    const slow = browser()
    const waited = startShell(slow.host)!
    slow.lock.grant()
    await slow.settle()
    slow.advance(2_500)
    await slow.settle()
    expect(waited.outcome()).toBe("none")
  })

  test("the mark set before the grant, or a wipe while waiting for it, means no read", async () => {
    const marked = browser()
    const shell = startShell(marked.host)!
    marked.setMark("1")
    marked.lock.grant()
    await marked.settle()
    expect([marked.read.url, shell.outcome(), marked.lock.held]).toEqual([undefined, "mark", false])

    const wiped = browser()
    const waiting = startShell(wiped.host)!
    wiped.channels[0]!.onmessage!(new MessageEvent("message", { data: "wipe" }))
    expect(wiped.lock.aborted).toBe(true)
    // A grant that comes anyway is let go at once.
    wiped.lock.grant()
    await wiped.settle()
    expect([wiped.read.url, waiting.outcome(), wiped.lock.held]).toEqual([undefined, "wipe", false])
  })

  test("the mark set after its paint goes at its next paint check", async () => {
    const b = browser()
    const shell = startShell(b.host)!
    b.lock.grant()
    await b.settle()
    b.setMark("1")
    b.read.answer(200, painted())
    await b.settle()
    await b.settle()
    expect([b.node(), shell.outcome()]).toEqual([null, "mark"])
  })

  test("hand-over: before the grant the shell stops asking; with the mark present it revokes; after its end, nothing", async () => {
    const early = browser()
    const shell = startShell(early.host)!
    expect(shell.handOver()).toBeUndefined()
    expect([early.lock.aborted, shell.outcome()]).toEqual([true, "revoked"])

    const marked = browser()
    const markedShell = startShell(marked.host)!
    await marked.paint(painted())
    marked.setMark("1")
    expect(markedShell.handOver()).toBeUndefined()
    await marked.settle()
    expect([marked.node(), marked.lock.held, markedShell.outcome()]).toEqual([null, false, "mark"])

    // Held and unmarked while the read is still out: adopted, and the read may still paint inside the page's hold.
    const reading = browser()
    const readingShell = startShell(reading.host)!
    reading.lock.grant()
    await reading.settle()
    const release = readingShell.handOver()!
    reading.read.answer(200, painted())
    await reading.settle()
    await reading.settle()
    expect([reading.node() !== null, reading.lock.held]).toEqual([true, true])
    release()
  })
})

const shells = new Map<ReturnType<typeof browser>, NonNullable<ReturnType<typeof startShell>>>()
const shellOf = (b: ReturnType<typeof browser>) => shells.get(b)!
