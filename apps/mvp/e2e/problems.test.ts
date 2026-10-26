import { describe, expect, it } from "vitest"
import {
  consoleErrorAnnotation,
  declarationsOf,
  declares,
  environmentAnnotations,
  EXPECTED_CONSOLE_ERROR,
  EXPECTED_SERVER_ERROR,
  type Observation,
  pathOf,
  problemOf,
  Problems,
  serverErrorAnnotation,
} from "./problems"

// What fails an e2e test unless it declares it (e2e/problems.ts): on 2026-10-25 smithers.sh answered its shapes 500 for
// a day and every spec passed, because the browser retried each shape and the specs checked only what rendered.

const ORIGIN = "https://smithers.example"
const app = (path: string) => `${ORIGIN}${path}`
const response = (status: number, url = app("/api/shapes/items?offset=-1&handle=h1"), method = "GET"): Observation => ({ kind: "response", method, url, status })
const failed = (error: string, overrides: Partial<Extract<Observation, { kind: "failed" }>> = {}): Observation => ({
  kind: "failed",
  method: "GET",
  url: app("/api/shapes/pulls?offset=-1"),
  error,
  ...overrides,
})
const consoleError = (text: string, url: string | undefined = undefined): Observation => ({ kind: "console", text, url })
const lineOf = (observation: Observation) => problemOf(ORIGIN, observation)?.line

describe("pathOf", () => {
  it("keeps the pathname and the query's parameter names, sorted and once each, without their values", () => {
    expect(pathOf(app("/api/shapes/items?offset=-1&handle=h1&live=true&handle=h2"))).toBe("/api/shapes/items?handle&live&offset")
    expect(pathOf(app("/smithersai/smithers"))).toBe("/smithersai/smithers")
  })

  it("writes each id as :id, so one path's failures count together", () => {
    expect(pathOf(app("/api/runs/0f8fad5b-d9cb-469f-a165-70867728950e/credential"))).toBe("/api/runs/:id/credential")
  })
})

describe("problemOf: responses", () => {
  it("counts a response of 500 or above from the app's origin, by status, method and path", () => {
    expect(lineOf(response(500))).toBe("500 GET /api/shapes/items?handle&offset")
    expect(lineOf(response(503, app("/api/questions"), "POST"))).toBe("503 POST /api/questions")
    expect(problemOf(ORIGIN, response(502))).toMatchObject({ kind: "server", status: 502, path: "/api/shapes/items?handle&offset" })
  })

  it("leaves a 4xx, and any other origin's 5xx, to the console check", () => {
    expect(lineOf(response(499))).toBeUndefined()
    expect(lineOf(response(401))).toBeUndefined()
    expect(lineOf(response(500, "https://api.github.com/repos/a/b"))).toBeUndefined()
  })
})

describe("problemOf: failed requests", () => {
  it("counts a failed /api/ request of the app's, with its error", () => {
    expect(lineOf(failed("net::ERR_HTTP2_PROTOCOL_ERROR"))).toBe("failed GET /api/shapes/pulls?offset net::ERR_HTTP2_PROTOCOL_ERROR")
    expect(problemOf(ORIGIN, failed("net::ERR_EMPTY_RESPONSE"))).toMatchObject({ kind: "server", status: "failed", path: "/api/shapes/pulls?offset" })
  })

  it("leaves out a request the page cancelled itself, in every browser: the server failing is another error", () => {
    for (const error of ["net::ERR_ABORTED", "NS_BINDING_ABORTED", "cancelled"]) {
      expect(lineOf(failed(error, { url: app("/api/telemetry/v1/logs"), method: "POST" }))).toBeUndefined()
    }
    expect(lineOf(failed("net::ERR_CONNECTION_RESET"))).toBe("failed GET /api/shapes/pulls?offset net::ERR_CONNECTION_RESET")
  })

  it("leaves out what an offline device couldn't send: the test took it offline", () => {
    expect(lineOf(failed("net::ERR_INTERNET_DISCONNECTED"))).toBeUndefined()
    expect(lineOf(failed("NS_ERROR_OFFLINE"))).toBeUndefined()
  })

  it("leaves out pages, assets and other origins' requests: only the app's /api/", () => {
    expect(lineOf(failed("net::ERR_FAILED", { url: app("/assets/index.js") }))).toBeUndefined()
    expect(lineOf(failed("net::ERR_FAILED", { url: "https://avatars.githubusercontent.com/api/u/1" }))).toBeUndefined()
  })
})

describe("problemOf: console and page errors", () => {
  it("leaves Chrome's line about the app's own 5xx to its response, which is already on the list", () => {
    expect(lineOf(consoleError("Failed to load resource: the server responded with a status of 500 ()", app("/api/shapes/items?offset=-1")))).toBeUndefined()
  })

  it("counts Chrome's line about a refused response by its status and path: a 4xx, or another origin's 5xx", () => {
    expect(problemOf(ORIGIN, consoleError("Failed to load resource: the server responded with a status of 401 ()", app("/api/shapes/pulls?offset=-1")))).toEqual({
      kind: "server",
      status: 401,
      path: "/api/shapes/pulls?offset",
      line: "console 401 /api/shapes/pulls?offset: Failed to load resource",
    })
    expect(lineOf(consoleError("Failed to load resource: the server responded with a status of 503 ()", "https://avatars.githubusercontent.com/u/1?s=40")))
      .toBe("console 503 https://avatars.githubusercontent.com/u/1?s: Failed to load resource")
    expect(lineOf(consoleError("Failed to load resource: the server responded with a status of 404 ()"))).toBe("console 404 (unknown): Failed to load resource")
  })

  it("leaves out Electric's 409 on a shape, which tells its client to start the shape again", () => {
    expect(lineOf(consoleError("Failed to load resource: the server responded with a status of 409 ()", app("/api/shapes/views?offset=1_0&handle=h")))).toBeUndefined()
    expect(lineOf(consoleError("Failed to load resource: the server responded with a status of 409 ()", app("/api/branches"))))
      .toBe("console 409 /api/branches: Failed to load resource")
    expect(lineOf(consoleError("Failed to load resource: the server responded with a status of 409 ()", "https://other.example/api/shapes/x")))
      .toBe("console 409 https://other.example/api/shapes/x: Failed to load resource")
  })

  it("leaves out a failed load from a server on this machine that isn't the app: a stopped test fixture", () => {
    for (const url of ["https://127.0.0.1:61109/icon.svg", "http://localhost:4000/a.png", "http://[::1]:9/x"]) {
      expect(lineOf(consoleError("Failed to load resource: net::ERR_CONNECTION_REFUSED", url))).toBeUndefined()
    }
    expect(lineOf(consoleError("Failed to load resource: net::ERR_CONNECTION_REFUSED", "https://example.com/icon.svg")))
      .toBe("console failed https://example.com/icon.svg net::ERR_CONNECTION_REFUSED")
  })

  it("leaves Chrome's line about a failed /api/ request, or an offline one, to the request check", () => {
    expect(lineOf(consoleError("Failed to load resource: net::ERR_INTERNET_DISCONNECTED", "https://fonts.example/a.woff2"))).toBeUndefined()
    expect(lineOf(consoleError("Failed to load resource: net::ERR_FAILED", app("/api/shapes/items")))).toBeUndefined()
  })

  it("counts any other failed load where it points, and any other console error, without an Effect logger's time and fiber", () => {
    expect(lineOf(consoleError("Failed to load resource: net::ERR_CONNECTION_REFUSED", app("/assets/a.js?v=1")))).toBe("console failed /assets/a.js?v net::ERR_CONNECTION_REFUSED")
    expect(lineOf(consoleError("Failed to load resource: net::ERR_FAILED", "https://fonts.example/a.woff2"))).toBe("console failed https://fonts.example/a.woff2 net::ERR_FAILED")
    expect(lineOf(consoleError("Failed to load resource: net::ERR_FAILED", "::not a url"))).toBe("console failed (unknown) net::ERR_FAILED")
    expect(lineOf(consoleError("Failed to load resource: net::ERR_FAILED"))).toBe("console failed (unknown) net::ERR_FAILED")
    expect(lineOf(consoleError("[17:58:34.793] ERROR (#74): chat load failed {status: 500}"))).toBe("console error: ERROR: chat load failed {status: 500}")
    expect(lineOf(consoleError("x".repeat(400)))).toBe(`console error: ${"x".repeat(300)}`)
  })

  it("counts every uncaught page error", () => {
    expect(problemOf(ORIGIN, { kind: "page", text: "TypeError: x is undefined" })).toEqual({ kind: "console", line: "page error: TypeError: x is undefined" })
  })
})

describe("declarations", () => {
  it("names a status on a path, or a failed request, as an annotation", () => {
    expect(serverErrorAnnotation(503, "/api/auth/session")).toEqual({ type: EXPECTED_SERVER_ERROR, description: "503 /api/auth/session" })
    expect(serverErrorAnnotation("failed", "/api/runs/*/credential")).toEqual({ type: EXPECTED_SERVER_ERROR, description: "failed /api/runs/*/credential" })
    expect(serverErrorAnnotation(401, "/api/shapes/pulls").description).toBe("401 /api/shapes/pulls")
    expect(consoleErrorAnnotation("Sync failed")).toEqual({ type: EXPECTED_CONSOLE_ERROR, description: "Sync failed" })
  })

  it("refuses what names no error: a status outside 4xx and 5xx, a path that isn't a pathname, no text", () => {
    for (const status of [200, 399, 600, 503.5]) expect(() => serverErrorAnnotation(status, "/api/x")).toThrow(/not a 4xx or 5xx/)
    for (const path of ["api/x", "/api/x?offset", "/api/a b"]) expect(() => serverErrorAnnotation(503, path)).toThrow(/not a pathname/)
    expect(() => consoleErrorAnnotation("  ")).toThrow(/name some text/)
  })

  it("reads the declarations among a test's annotations and refuses a malformed one", () => {
    const read = declarationsOf([
      { type: "summary", description: "a flow" },
      serverErrorAnnotation(503, "/api/auth/session"),
      serverErrorAnnotation("failed", "/api/questions"),
      consoleErrorAnnotation("Sync failed"),
      { type: EXPECTED_CONSOLE_ERROR },
    ])
    expect(read.map((each) => each.kind)).toEqual(["server", "server", "console", "console"])
    expect(() => declarationsOf([{ type: EXPECTED_SERVER_ERROR, description: "five hundred" }])).toThrow(/use expectServerError/)
    expect(() => declarationsOf([{ type: EXPECTED_SERVER_ERROR }])).toThrow(/use expectServerError/)
  })

  it("matches a server error by status and pathname, `*` standing for any characters, whatever its query", () => {
    const [session, credential, refused] = declarationsOf([
      serverErrorAnnotation(503, "/api/auth/session"),
      serverErrorAnnotation("failed", "/api/runs/*/credential"),
      serverErrorAnnotation(401, "/api/shapes/pulls"),
    ])
    const of = (observation: Observation) => problemOf(ORIGIN, observation)!
    expect(declares(session!, of(response(503, app("/api/auth/session?probe=1"))))).toBe(true)
    expect(declares(session!, of(response(500, app("/api/auth/session"))))).toBe(false)
    expect(declares(session!, of(response(503, app("/api/auth/session/extra"))))).toBe(false)
    expect(declares(credential!, of(failed("net::ERR_FAILED", { url: app("/api/runs/0f8fad5b-d9cb-469f-a165-70867728950e/credential") })))).toBe(true)
    expect(declares(credential!, of(response(503, app("/api/runs/r1/credential"))))).toBe(false)
    expect(declares(refused!, of(consoleError("Failed to load resource: the server responded with a status of 401 ()", app("/api/shapes/pulls?offset=-1"))))).toBe(true)
    expect(declares(session!, of({ kind: "page", text: "503 /api/auth/session" }))).toBe(false)
  })

  it("matches a console or page error by the text its line contains; a declaration without text matches nothing", () => {
    const [sync, blank] = declarationsOf([consoleErrorAnnotation("Sync failed"), { type: EXPECTED_CONSOLE_ERROR }])
    const page = problemOf(ORIGIN, { kind: "page", text: "Error: Sync failed at shape" })!
    expect(declares(sync!, page)).toBe(true)
    expect(declares(sync!, problemOf(ORIGIN, consoleError("Something else"))!)).toBe(false)
    expect(declares(blank!, page)).toBe(false)
    expect(declares(sync!, problemOf(ORIGIN, response(500))!)).toBe(false)
  })
})

describe("environmentAnnotations", () => {
  it("declares what a local dev server answers for each service it runs without, and nothing for a full deployment", () => {
    expect(environmentAnnotations({ codeStorage: false, model: false, github: false })).toEqual([])
    const declared = (lacks: Parameters<typeof environmentAnnotations>[0], observation: Observation) =>
      declarationsOf(environmentAnnotations(lacks)).some((each) => declares(each, problemOf(ORIGIN, observation)!))
    const refs = response(503, app("/api/repos/octocat/Spoon-Knife/refs"))
    const tree = response(503, app("/api/repos/octocat/Spoon-Knife/tree/abc123"))
    const clone = response(503, app("/api/repos"), "POST")
    const model = response(502, app("/api/model/summary"), "POST")
    const about = response(503, app("/api/repos/octocat/linguist/about"))
    const all = { codeStorage: true, model: true, github: true }
    for (const each of [refs, tree, clone, model, about]) expect(declared(all, each)).toBe(true)
    expect(declared({ ...all, codeStorage: false }, refs)).toBe(false)
    expect(declared({ ...all, model: false }, model)).toBe(false)
    expect(declared({ ...all, github: false }, about)).toBe(false)
    // Only what each missing service answers: another status or route is still the app's.
    expect(declared(all, response(500, app("/api/repos/octocat/Spoon-Knife/refs")))).toBe(false)
    expect(declared(all, response(503, app("/api/shapes/items")))).toBe(false)
  })
})

describe("Problems", () => {
  it("counts each problem by its line, in the order each first happened, and ignores what isn't one", () => {
    const problems = new Problems(ORIGIN)
    problems.note(response(500))
    problems.note(response(200))
    problems.note({ kind: "page", text: "boom" })
    problems.note(response(500, app("/api/shapes/items?offset=0_0&handle=h2")))
    expect(problems.list([])).toEqual([
      { line: "500 GET /api/shapes/items?handle&offset", count: 2, declared: false },
      { line: "page error: boom", count: 1, declared: false },
    ])
  })

  it("fails a test on what it didn't declare, and lists everything for its browser.log", () => {
    const problems = new Problems(ORIGIN)
    expect(problems.undeclared([])).toEqual([])
    expect(problems.report([])).toEqual(["problems: none"])
    problems.note(response(503, app("/api/auth/session")))
    problems.note(response(500))
    problems.note(response(500))
    const annotations = [serverErrorAnnotation(503, "/api/auth/session")]
    expect(problems.undeclared(annotations)).toEqual(["500 GET /api/shapes/items?handle&offset ×2"])
    expect(problems.report(annotations)).toEqual([
      "problems (e2e/problems.ts):",
      "  declared 503 GET /api/auth/session ×1",
      "  UNDECLARED 500 GET /api/shapes/items?handle&offset ×2",
    ])
  })
})
