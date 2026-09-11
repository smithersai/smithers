import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ClientErrorFetch } from "./ClientErrors"
import {
  byteLength,
  CLIENT_ERROR_BODY_MAX_BYTES,
  CLIENT_ERROR_REPORT_LIMIT,
  CLIENT_ERROR_URL_MAX_BYTES,
  CLIENT_ERRORS_PATH,
  clientErrorBody,
  createClientErrorReporter,
  errorMessage
} from "./ClientErrors"

/*
 * E14.4 — client errors reach a sink.
 *
 * Two halves are proved here, and only one of them is about this module.
 *
 * The half that matters is the CONTRACT with the Worker: the path the page
 * posts to is the path the Worker routes, the biggest body this reporter can
 * build is one the route will accept, measured in the Worker's unit (UTF-8
 * bytes on the wire), and AppIsland.tsx reports through THIS module rather than
 * through a copy of it. Every one of those can break from a change made in a
 * different file, in a way nothing else in the suite would notice: the sink
 * would simply go quiet, which looks exactly like no crashes.
 *
 * The second half is the reporter's own behaviour. It is worth pinning because
 * the size bound above depends on the truncation being real.
 */

const readSource = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")

/*
 * The sink is the local origin (src/bun/server.ts) in the local app; the
 * deployed Worker used to hold this half of the contract.
 */
const serverIndex = readSource("../../bun/server.ts")
const mainSource = readSource("../main.tsx")
const islandSource = readSource("../AppIsland.tsx")
const watchdogSource = readSource("../StartupWatchdog.ts")

/** A `const NAME = "value";` declaration in the Worker, or undefined. */
const serverString = (name: string): string | undefined =>
  new RegExp(`const ${name} = "([^"]+)"`).exec(serverIndex)?.[1]

/** A `const NAME = 16 * 1024;` style declaration in the Worker, or undefined. */
const serverBytes = (name: string): number | undefined => {
  const match = new RegExp(`const ${name} = (\\d+)(?: \\* (\\d+))?`).exec(serverIndex)
  if (match === null) return undefined
  const base = Number(match[1])
  return match[2] === undefined ? base : base * Number(match[2])
}

interface Sent {
  readonly input: string
  readonly init: RequestInit
}

const recordingFetch = (): { readonly sends: Array<Sent>; readonly fetchImpl: ClientErrorFetch } => {
  const sends: Array<Sent> = []
  const fetchImpl: ClientErrorFetch = (input, init) => {
    sends.push({ input, init })
    return Promise.resolve(new Response(JSON.stringify({ status: "accepted" }), { status: 202 }))
  }
  return { sends, fetchImpl }
}

const bodyOf = (sent: Sent): Record<string, unknown> => JSON.parse(String(sent.init.body)) as Record<string, unknown>

describe("the client-error reporter's contract with the local origin", () => {
  test("posts to the path the Worker actually routes, by the method it routes", () => {
    // Red when the Worker renames the route or stops accepting POST: every
    // crash report would 404 and the admin error log would stay empty.
    expect(serverString("CLIENT_ERRORS_PATH")).toBe(CLIENT_ERRORS_PATH)
    expect(serverIndex).toContain("router.add(\"POST\", CLIENT_ERRORS_PATH, ")
    const { sends, fetchImpl } = recordingFetch()
    createClientErrorReporter({ fetchImpl, pathname: () => "/" }).report("error", new Error("boom"))
    expect(sends[0]?.input).toBe(CLIENT_ERRORS_PATH)
    expect(sends[0]?.init.method).toBe("POST")
  })

  test("bounds the body by the Worker's own number, in the Worker's own unit", () => {
    // The route measures `body.byteLength` — bytes on the wire — so the
    // client's bound has to be bytes too. Red if either side moves its cap
    // without the other, and red if the client goes back to bounding
    // characters, which under-measures non-ASCII by up to six times.
    expect(CLIENT_ERROR_BODY_MAX_BYTES).toBe(serverBytes("CLIENT_ERROR_MAX_BODY") ?? 0)
    expect(CLIENT_ERROR_BODY_MAX_BYTES).toBe(16 * 1024)
    expect(serverIndex).toContain("if (body.byteLength > CLIENT_ERROR_MAX_BODY) {")
  })

  test("no report it can build exceeds the route's cap, in any alphabet", () => {
    // Red when the bound is raised, dropped, or counted in characters: the
    // route answers 413 and every one of these reports is lost, while the
    // client goes on believing it reported.
    const maxBody = serverBytes("CLIENT_ERROR_MAX_BODY") ?? 0
    const longPath = (unit: string): string => `/${unit.repeat(4_000)}`
    const runaways: ReadonlyArray<readonly [string, string, string]> = [
      ["ascii", "x".repeat(500_000), longPath("p")],
      // Three UTF-8 bytes a character: a stack trace in Japanese.
      ["japanese", "亜".repeat(500_000), longPath("亜")],
      // Four bytes, and two UTF-16 code units, so a slice can split one.
      ["astral", "\u{1d518}".repeat(200_000), longPath("\u{1d518}")],
      // JSON escapes a control character to six bytes.
      ["control", "\u0001".repeat(200_000), longPath("\u0001")],
      // A lone surrogate, which JSON.stringify escapes rather than emits.
      ["lone surrogate", "\ud800".repeat(200_000), longPath("\ud800")]
    ]
    for (const [name, runaway, path] of runaways) {
      const posted = clientErrorBody("error", runaway, new Date(0), path)
      // Named so a failure says which alphabet overflowed.
      expect({ name, over: byteLength(posted) > maxBody }).toEqual({ name, over: false })
      // A bound that cut the report to nothing would also pass the line
      // above. The point is to deliver the head of the stack.
      const message = String((JSON.parse(posted) as { message: unknown }).message)
      expect({ name, kept: message.length > 0 }).toEqual({ name, kept: true })
      expect(message[0]).toBe(runaway[0] as string)
    }
  })

  test("spends the budget it has instead of truncating to a token amount", () => {
    // The proportional cut lands close to the cap. Subtracting the byte
    // excess from a character count — the obvious wrong fix — collapses
    // non-ASCII input to an empty message and reports nothing.
    const posted = clientErrorBody("error", "亜".repeat(100_000), new Date(0), "/chat")
    expect(byteLength(posted)).toBeGreaterThan(CLIENT_ERROR_BODY_MAX_BYTES - 256)
    expect(byteLength(posted)).toBeLessThanOrEqual(CLIENT_ERROR_BODY_MAX_BYTES)
  })

  test("caps the page path, so a runaway URL cannot crowd out the stack", () => {
    const posted = clientErrorBody("error", new Error("boom"), new Date(0), `/${"亜".repeat(10_000)}`)
    const report = JSON.parse(posted) as { url: string; message: string }
    expect(byteLength(report.url)).toBeLessThanOrEqual(CLIENT_ERROR_URL_MAX_BYTES)
    expect(report.message).toContain("boom")
  })

  test("main.tsx reports through this module and holds no bound of its own", () => {
    // The defect this pins: main.tsx once carried its own copy of the
    // reporter, with its own limit and its own truncation, so everything
    // asserted above was asserted about code the app never ran.
    // main.tsx renders AppIsland, and AppIsland is where the watchdog is built.
    expect(mainSource).toContain("from \"./AppIsland\"")
    expect(islandSource).toContain("from \"./StartupWatchdog\"")
    expect(watchdogSource).toContain("from \"./state/ClientErrors\"")
    expect(watchdogSource).toContain("createClientErrorReporter(")
    expect(watchdogSource).not.toMatch(/const CLIENT_ERROR/)
    expect(watchdogSource).not.toMatch(/\.slice\(0, 4_?000\)/)
    expect(watchdogSource).not.toMatch(/fetch\(\s*["'`]\/api\//)
  })

  test("main.tsx still routes both window listeners into a client-error report", () => {
    // Red when the wiring is deleted or one listener stops reporting. The
    // app keeps running, so nothing else here would ever notice.
    expect(watchdogSource).toContain("windowTarget.addEventListener(\"error\"")
    expect(watchdogSource).toContain("windowTarget.addEventListener(\"unhandledrejection\"")
    expect(watchdogSource).toMatch(/report\w*\("error"/)
    expect(watchdogSource).toMatch(/report\w*\("unhandledrejection"/)
  })

  test("no file in the app posts to a client-error path other than the constant", () => {
    // Red on the drift that started this effort: a literal renamed in one
    // place and left stale in another, with both sides still green.
    const literals = new Set<string>()
    const root = fileURLToPath(new URL("../../", import.meta.url))
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    for (const relative of files) {
      if (!/\.(ts|tsx)$/.test(relative)) continue
      if (relative.endsWith("ClientErrors.test.ts")) continue
      const text = readFileSync(`${root}${relative}`, "utf8")
      for (const match of text.matchAll(/["'`](\/api\/client-error[^"'`]*)["'`]/g)) {
        literals.add(match[1] as string)
      }
    }
    expect(files.length).toBeGreaterThan(50)
    expect([...literals]).toEqual([CLIENT_ERRORS_PATH])
  })
})

describe("the client-error reporter", () => {
  test("sends one JSON report carrying the kind, the stack, the page and the time", () => {
    const { sends, fetchImpl } = recordingFetch()
    const reporter = createClientErrorReporter({
      fetchImpl,
      now: () => new Date("2026-08-18T12:00:00.000Z"),
      pathname: () => "/chat"
    })
    reporter.report("error", new Error("boom"))
    expect(sends).toHaveLength(1)
    expect((sends[0]?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json"
    )
    expect(sends[0]?.init.keepalive).toBe(true)
    const body = bodyOf(sends[0] as Sent)
    expect(body["kind"]).toBe("error")
    expect(body["url"]).toBe("/chat")
    expect(body["at"]).toBe("2026-08-18T12:00:00.000Z")
    expect(String(body["message"])).toContain("boom")
  })

  test("keeps the stack, not just the error's name", () => {
    // Red if errorMessage degrades to String(error): the log would read
    // "Error: boom" for every crash and name no line of code.
    const message = errorMessage(new Error("boom"))
    expect(message).toContain("ClientErrors.test")
  })

  test("reports a rejection reason that is not an Error at all", () => {
    const { sends, fetchImpl } = recordingFetch()
    createClientErrorReporter({ fetchImpl, pathname: () => "/" }).report(
      "unhandledrejection",
      "plain string reason"
    )
    const body = bodyOf(sends[0] as Sent)
    expect(body["kind"]).toBe("unhandledrejection")
    expect(body["message"]).toBe("plain string reason")
  })

  test("cuts a runaway message so the body it posts fits the cap", () => {
    const { sends, fetchImpl } = recordingFetch()
    createClientErrorReporter({ fetchImpl, pathname: () => "/" }).report("error", "y".repeat(100_000))
    expect(byteLength(String(sends[0]?.init.body))).toBeLessThanOrEqual(CLIENT_ERROR_BODY_MAX_BYTES)
    expect(String(bodyOf(sends[0] as Sent)["message"]).startsWith("yyy")).toBe(true)
  })

  test.each([
    ["null-prototype object", Object.create(null), "[object Object]"],
    ["symbol", Symbol("rejected"), "Symbol(rejected)"],
    ["throwing conversion hooks", {
      [Symbol.toPrimitive]() { throw new Error("cannot stringify") },
      get [Symbol.toStringTag]() { throw new Error("cannot label") }
    }, "Unknown error"]
  ] as const)("delivers a report for a %s rejection reason without throwing", (_name, reason, message) => {
    const { sends, fetchImpl } = recordingFetch()
    const reporter = createClientErrorReporter({ fetchImpl, pathname: () => "/" })
    expect(() => reporter.report("unhandledrejection", reason)).not.toThrow()
    expect(sends).toHaveLength(1)
    expect(bodyOf(sends[0] as Sent)).toMatchObject({ kind: "unhandledrejection", message })
    expect(reporter.reported()).toBe(1)
  })

  test.each([
    ["clock callback", { now: () => { throw new Error("clock failed") } }],
    ["pathname callback", { pathname: () => { throw new Error("location failed") } }],
    ["date serialization", { now: () => new Date(NaN) }]
  ] as const)("contains failures in %s and still caps attempts", (_name, options) => {
    const { sends, fetchImpl } = recordingFetch()
    const reporter = createClientErrorReporter({ fetchImpl, pathname: () => "/", limit: 2, ...options })
    for (let index = 0; index < 3; index += 1) {
      expect(() => reporter.report("error", new Error("boom"))).not.toThrow()
    }
    expect(sends).toHaveLength(0)
    expect(reporter.reported()).toBe(2)
  })

  test("stops after the per-page cap however many times it is called", () => {
    const { sends, fetchImpl } = recordingFetch()
    const reporter = createClientErrorReporter({ fetchImpl, pathname: () => "/" })
    for (let index = 0; index < 25; index += 1) reporter.report("error", new Error(`e${index}`))
    expect(sends).toHaveLength(CLIENT_ERROR_REPORT_LIMIT)
    expect(reporter.reported()).toBe(CLIENT_ERROR_REPORT_LIMIT)
  })

  test("swallows a failing send instead of raising a second error", () => {
    const rejecting: ClientErrorFetch = () => Promise.reject(new Error("offline"))
    expect(() =>
      createClientErrorReporter({ fetchImpl: rejecting, pathname: () => "/" }).report(
        "error",
        new Error("boom")
      )
    ).not.toThrow()
    const throwing: ClientErrorFetch = () => {
      throw new TypeError("fetch is not defined")
    }
    expect(() =>
      createClientErrorReporter({ fetchImpl: throwing, pathname: () => "/" }).report(
        "error",
        new Error("boom")
      )
    ).not.toThrow()
  })
})
