// Bug reports in the browser (docs/features/bugs.md): what a report says the tab showed, as pure functions of what
// the tab recorded; GitHub's prefilled form; and the tab's answer over the real bug channel, which only the tab that
// started the report's request gives.
import { TabChannel } from "@smthrs/platform-browser"
import { Effect, Exit, Layer, Option, Scope } from "effect"
import { describe, expect, test } from "vitest"
import { type ErrorRecord, TabErrors } from "../../flows/errors"
import { type Ran, TabHistory } from "../../flows/history"
import { TabRequests } from "../../flows/requests"
import { MAX_ERRORS, MAX_RECENT } from "./contract"
import { contextOf, isBugPage, type Recorded, repoOf, routeOf, UNANSWERED } from "./context"
import { BugTabs } from "./flows"
import { issueUrl, MAX_ISSUE_WORDS, routeKind, titleOf } from "./github"
import type { ReportRequest } from "./schema"
import { type BugHost, PAGES_KEPT, tabBugContext } from "./tab"

const TRACE = "0123456789abcdef0123456789abcdef"
const OTHER_TRACE = "fedcba9876543210fedcba9876543210"

const ran = (overrides: Partial<Ran> = {}): Ran => ({
  flow: "app/theme/set",
  executionId: "run-1",
  door: "button",
  outcome: "done",
  traceId: TRACE,
  ...overrides,
})

const recorded = (overrides: Partial<Recorded> = {}): Recorded => ({
  current: "/octocat/Spoon-Knife",
  pages: [],
  ran: [],
  errors: [],
  build: "38569d55ad79",
  browser: "Test/1.0",
  viewport: "1280x800",
  ...overrides,
})

describe("where the bug was", () => {
  test("the bug inbox and its form are never where a bug was", () => {
    expect(isBugPage("/app/bugs")).toBe(true)
    expect(isBugPage("/app/bugs/report")).toBe(true)
    expect(isBugPage("/app/bugsy")).toBe(false)
    expect(isBugPage("/app/runs")).toBe(false)
  })

  test("the page shown now, unless it is the form; then the latest page before it; none when only bug pages", () => {
    expect(routeOf("/app/runs", ["/a/b"])).toBe("/app/runs")
    expect(routeOf("/app/bugs/report", ["/app/bugs", "/octocat/Spoon-Knife/issues", "/app/runs"])).toBe(
      "/octocat/Spoon-Knife/issues",
    )
    expect(routeOf(undefined, ["/app/runs"])).toBe("/app/runs")
    expect(routeOf("/app/bugs/report", ["/app/bugs"])).toBeNull()
    expect(routeOf(undefined, [])).toBeNull()
    expect(routeOf(`/a/${"x".repeat(3_000)}`, [])).toHaveLength(2_048)
  })

  test("the repository a page shows, from its path; the app's own pages and odd names show none", () => {
    expect(repoOf("/octocat/Spoon-Knife")).toBe("octocat/Spoon-Knife")
    expect(repoOf("/octocat/Spoon-Knife/blob/main/README.md?L=3")).toBe("octocat/Spoon-Knife")
    expect(repoOf("/smithersai/smithers#top")).toBe("smithersai/smithers")
    for (const path of ["/app/runs", "/api/bugs", "/docs/x", "/auth/x", "/", "/octocat", "/a b/c", "/../x", "/x/..", "/./x", "/x/."]) {
      expect(repoOf(path), path).toBeNull()
    }
    expect(repoOf(null)).toBeNull()
  })
})

describe("what a report carries", () => {
  test("the page, its repository, the build, and the latest distinct trace ids, run ids and failure codes", () => {
    const context = contextOf(recorded({
      current: "/app/bugs/report",
      pages: ["/octocat/Spoon-Knife/issues"],
      ran: [
        ran({ flow: "app/bug/report", executionId: "run-3", outcome: "failed", code: "BugRefused", traceId: OTHER_TRACE }),
        ran({ executionId: "run-2", outcome: "error", code: "person_only" }),
        ran({ executionId: "run-2", outcome: "error", code: "person_only" }),
        ran({ executionId: "run-1" }),
      ],
    }))
    expect(context).toEqual({
      route: "/octocat/Spoon-Knife/issues",
      repo: "octocat/Spoon-Knife",
      build: "38569d55ad79",
      traces: [OTHER_TRACE, TRACE],
      runs: ["run-3", "run-2", "run-1"],
      failures: [{ flow: "app/bug/report", code: "BugRefused" }, { flow: "app/theme/set", code: "person_only" }],
      errors: [],
      browser: "Test/1.0",
      viewport: "1280x800",
    })
  })

  test("the tab's latest error records, at most thirty; one that doesn't fit a report is left out", () => {
    const record = (overrides: Partial<ErrorRecord> = {}): ErrorRecord => ({
      at: "2026-10-25T20:00:00.000Z",
      kind: "log",
      name: "flow.dispatch",
      code: "refused",
      traceId: TRACE,
      ...overrides,
    })
    const errors = [
      record({ kind: "http", name: "GET /api/repos/octocat/Spoon-Knife%20x", code: "503", traceId: null }),
      record({ kind: "page", name: "page error", code: "TypeError" }),
      record({ name: "said <b>hi</b>" }),
      record({ code: "two words" }),
      record({ traceId: "nope" }),
      record({ at: "x".repeat(41) }),
      ...Array.from({ length: 40 }, () => record()),
    ]
    const kept = contextOf(recorded({ errors })).errors
    expect(kept).toHaveLength(MAX_ERRORS)
    expect(kept.slice(0, 3)).toEqual([errors[0], errors[1], record()])
  })

  test("an id or code that doesn't fit its shape is left out; a failure without a code isn't one; text is cut", () => {
    const context = contextOf(recorded({
      ran: [
        ran({ traceId: "not-a-trace", executionId: "has space", outcome: "failed", code: "a b" }),
        ran({ traceId: undefined, executionId: "ok-run", outcome: "failed" }),
        ran({ flow: "bad flow!", outcome: "error", code: "x" }),
      ],
      build: "b".repeat(80),
      browser: "u".repeat(600),
      viewport: "v".repeat(40),
    }))
    expect(context.traces).toEqual([TRACE])
    expect(context.runs).toEqual(["ok-run", "run-1"])
    expect(context.failures).toEqual([])
    expect(context.build).toHaveLength(64)
    expect(context.browser).toHaveLength(512)
    expect(context.viewport).toHaveLength(32)
  })

  test("at most the latest twenty of each", () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      ran({
        executionId: `run-${index}`,
        traceId: index.toString(16).padStart(32, "0"),
        outcome: "failed",
        code: `code-${index}`,
      })
    )
    const context = contextOf(recorded({ ran: many }))
    expect(context.traces).toHaveLength(MAX_RECENT)
    expect(context.runs).toHaveLength(MAX_RECENT)
    expect(context.failures).toHaveLength(MAX_RECENT)
    expect(context.runs[0]).toBe("run-0")
  })

  test("a report whose tab didn't answer still names nothing it doesn't know", () => {
    expect(UNANSWERED).toEqual({
      route: null,
      repo: null,
      build: "unknown",
      traces: [],
      runs: [],
      failures: [],
      errors: [],
      browser: "unknown",
      viewport: "unknown",
    })
  })
})

const report: ReportRequest = {
  id: "8d0f6c1e-2b7a-4c55-9f0e-0123456789ab",
  what: "The run page stays blank\nafter I press Retry.",
  route: "/octocat/private-thing/issues/3",
  repo: "octocat/private-thing",
  build: "38569d55ad79",
  traces: [TRACE, OTHER_TRACE],
  runs: ["run-1"],
  failures: [{ flow: "run/retry", code: "refused" }],
  errors: [
    { at: "2026-10-25T20:00:00.000Z", kind: "http", name: "GET /api/runs", code: "503", traceId: null },
    { at: "2026-10-25T19:59:00.000Z", kind: "page", name: "page error", code: null, traceId: null },
  ],
  browser: "Test/1.0",
  viewport: "1280x800",
}

describe("Open on GitHub", () => {
  test("what kind of page, never its path", () => {
    expect(routeKind(null)).toBe("unknown")
    expect(routeKind("/")).toBe("launcher")
    expect(routeKind("/app")).toBe("app")
    expect(routeKind("/app/runs/abc")).toBe("app/runs")
    expect(routeKind("/app/b<x>")).toBe("app/bx")
    expect(routeKind("/o/r/blob/main/a.ts")).toBe("file")
    expect(routeKind("/o/r/tree/main")).toBe("file")
    expect(routeKind("/o/r/issues/3?x=1")).toBe("issues")
    expect(routeKind("/o/r/pull/3")).toBe("pull-request")
    expect(routeKind("/o/r/pulls")).toBe("pull-request")
    expect(routeKind("/o/r")).toBe("repository")
    expect(routeKind("/o")).toBe("other")
  })

  test("the title is the first line, at most 80 characters", () => {
    expect(titleOf("  Blank page\nmore")).toBe("Blank page")
    expect(titleOf("x".repeat(100))).toBe(`${"x".repeat(79)}…`)
  })

  test("GitHub's form on the repository the page showed, with the words, ids and the kind of page", () => {
    const url = new URL(issueUrl(report))
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/octocat/private-thing/issues/new")
    expect(url.searchParams.get("title")).toBe("The run page stays blank")
    expect(url.searchParams.get("body")).toBe([
      "The run page stays blank\nafter I press Retry.",
      "",
      `Report: ${report.id}`,
      "Page: issues",
      "Build: 38569d55ad79",
      `Traces: ${TRACE} ${OTHER_TRACE}`,
      "Failures: run/retry refused",
      "Errors: GET /api/runs 503, page error",
      "Browser: Test/1.0",
      "Window: 1280x800",
    ].join("\n"))
    // A public issue never names the page's path, which can name a private repository's files.
    expect(url.searchParams.get("body")).not.toContain("/octocat/private-thing")
  })

  test("legacy raw HTTP errors are redacted before the public GitHub prefill", () => {
    const url = new URL(issueUrl({ ...report, repo: null, route: "/app", errors: [
      { ...report.errors[0]!, kind: "http", name: "GET /api/repos/private-owner/payroll-private/contents/config/keys.env?token=private-query" },
      { ...report.errors[0]!, kind: "http", name: "private malformed HTTP error" },
    ] }))
    expect(url.searchParams.get("body")).toContain("GET /api/repos/:owner/:repo/:id/:id/:id")
    expect(url.searchParams.get("body")).not.toMatch(/private|keys\.env/)
  })

  test("smithersai/smithers when the page showed no repository; long words cut; no empty lines for ids", () => {
    const url = new URL(issueUrl({ ...report, repo: null, route: null, what: "w".repeat(3_000), traces: [], failures: [], errors: [] }))
    expect(url.pathname).toBe("/smithersai/smithers/issues/new")
    const body = url.searchParams.get("body")!
    expect(body.startsWith(`${"w".repeat(MAX_ISSUE_WORDS)}…\n`)).toBe(true)
    expect(body).not.toContain("Traces:")
    expect(body).not.toContain("Failures:")
    expect(body).not.toContain("Errors:")
    expect(body).toContain("Page: unknown")
  })
})

/** A tab answering the bug channel of engine `name` with `host`, and its history and requests, in `scope`. */
const openTab = async (scope: Scope.Scope, host: BugHost, options: { readonly history?: boolean } = {}) => {
  const layer = tabBugContext(host).pipe(
    Layer.provideMerge(Layer.mergeAll(
      TabRequests.layer(),
      options.history === false ? Layer.empty : Layer.merge(TabHistory.layer(), TabErrors.ring()),
    )),
    Layer.provide(TabChannel.layer),
  )
  const context = await Effect.runPromise(Scope.provide(scope)(Layer.build(layer)))
  return {
    requests: Effect.runSync(Effect.service(TabRequests).pipe(Effect.provide(context))),
    history: Option.getOrUndefined(Effect.runSync(Effect.serviceOption(TabHistory).pipe(Effect.provide(context)))),
    errors: Option.getOrUndefined(Effect.runSync(Effect.serviceOption(TabErrors).pipe(Effect.provide(context)))),
  }
}

/** The step's side of the bug channel of engine `name`. */
const asking = async (scope: Scope.Scope, name: string) => {
  const context = await Effect.runPromise(
    Scope.provide(scope)(Layer.build(BugTabs.layerChannel({ name, within: "300 millis" }).pipe(Layer.provide(TabChannel.layer)))),
  )
  return Effect.runSync(Effect.service(BugTabs).pipe(Effect.provide(context)))
}

describe("the tab that asked answers", () => {
  test("with the page before the form, the build, its runs and the window; another tab's request gets no answer", async () => {
    const scope = Effect.runSync(Scope.make())
    try {
      const name = `bugs-${crypto.randomUUID()}`
      const listeners = new Set<(path: string) => void>()
      let stopped = 0
      let now = "/octocat/Spoon-Knife/issues"
      const tab = await openTab(scope, {
        name,
        build: "38569d55ad79",
        pathname: () => now,
        pages: (listener) => {
          listeners.add(listener)
          return () => {
            stopped += 1
            listeners.delete(listener)
          }
        },
        screen: () => ({ browser: "Test/1.0", viewport: "1280x800" }),
      })
      const show = async (path: string) => {
        now = path
        for (const listener of listeners) listener(path)
        await Effect.runPromise(Effect.sleep("20 millis"))
      }
      await show("/app/runs")
      await show("/app/runs")
      await show("/octocat/Spoon-Knife/issues")
      await show("/app/bugs/report")
      await Effect.runPromise(tab.requests.add("report-1", "button"))
      await Effect.runPromise(tab.history!.record(ran({ executionId: "nav-1", flow: "app/navigate" })))
      tab.errors!.record({ at: "2026-10-25T20:00:00.000Z", kind: "http", name: "POST /api/bugs", code: "503", traceId: null })
      const bugs = await asking(scope, name)
      expect(await Effect.runPromise(bugs.ask("report-1"))).toEqual(Option.some({
        route: "/octocat/Spoon-Knife/issues",
        repo: "octocat/Spoon-Knife",
        build: "38569d55ad79",
        traces: [TRACE],
        runs: ["nav-1"],
        failures: [],
        errors: [{ at: "2026-10-25T20:00:00.000Z", kind: "http", name: "POST /api/bugs", code: "503", traceId: null }],
        browser: "Test/1.0",
        viewport: "1280x800",
      }))
      expect(await Effect.runPromise(bugs.ask("someone-elses"))).toEqual(Option.none())
      await Effect.runPromise(Scope.close(scope, Exit.void))
      expect(stopped).toBe(1)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })

  test("keeps only its latest pages", async () => {
    const scope = Effect.runSync(Scope.make())
    try {
      const name = `bugs-${crypto.randomUUID()}`
      let emit: (path: string) => void = () => {}
      const tab = await openTab(scope, {
        name,
        build: "b",
        pathname: () => "/app/bugs/report",
        pages: (listener) => {
          emit = listener
          return () => {}
        },
      })
      // Pages come one at a time, as a person moves.
      for (const path of [...Array.from({ length: PAGES_KEPT + 1 }, (_, index) => `/o/r${index}`), "/app/bugs/report"]) {
        emit(path)
        await Effect.runPromise(Effect.sleep("5 millis"))
      }
      await Effect.runPromise(tab.requests.add("report-2", "slash"))
      const answered = await Effect.runPromise((await asking(scope, name)).ask("report-2"))
      expect(Option.getOrThrow(answered).route).toBe(`/o/r${PAGES_KEPT}`)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })

  test("a host without a router, a window or a history answers what it can", async () => {
    const scope = Effect.runSync(Scope.make())
    try {
      const name = `bugs-${crypto.randomUUID()}`
      const tab = await openTab(scope, { name, build: "dev" }, { history: false })
      await Effect.runPromise(tab.requests.add("report-3", "key"))
      expect(await Effect.runPromise((await asking(scope, name)).ask("report-3"))).toEqual(Option.some({
        route: null,
        repo: null,
        build: "dev",
        traces: [],
        runs: [],
        failures: [],
        errors: [],
        browser: "unknown",
        viewport: "unknown",
      }))
      // A router that says where it is but not where it was: the page now.
      const located = `bugs-${crypto.randomUUID()}`
      const here = await openTab(scope, { name: located, build: "dev", pathname: () => "/octocat/Spoon-Knife" })
      await Effect.runPromise(here.requests.add("report-4", "key"))
      const answered = await Effect.runPromise((await asking(scope, located)).ask("report-4"))
      expect(Option.getOrThrow(answered)).toMatchObject({ route: "/octocat/Spoon-Knife", repo: "octocat/Spoon-Knife" })
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })
})
