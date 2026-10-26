import { type Browser, type BrowserContext, expect, test as base, type Page, type TestInfo } from "@playwright/test"
import { appendFile } from "node:fs/promises"
import { recordConsole } from "./console"
import { consoleErrorAnnotation, environmentAnnotations, Problems, serverErrorAnnotation, type Status, UNDECLARED } from "./problems"
import { baseURL, DOT_ENV, dotEnvSets, meets, onThisMachine, target } from "./target"

// Every browser context a test opens is watched from its first request (docs/infrastructure.md#server-and-console-errors):
// its pages' responses and failed requests, and their console and page errors, go to the test's Problems
// (e2e/problems.ts). The default page's context, each device's (e2e/devices.ts) and any a test opens itself
// (`browser.newContext()`) alike. At teardown a test fails on each problem it didn't declare.

/** A test's problems, fed by every context it opens. */
export class Watched extends Problems {
  private readonly contexts = new WeakSet<BrowserContext>()
  private readonly pages = new WeakSet<Page>()

  /** Watches `context` and its pages from now on; watching one twice changes nothing. */
  watch(context: BrowserContext): void {
    if (this.contexts.has(context)) return
    this.contexts.add(context)
    context.on("page", (page) => this.watchPage(page))
    for (const page of context.pages()) this.watchPage(page)
    context.on("response", (response) =>
      this.note({ kind: "response", method: response.request().method(), url: response.url(), status: response.status() }))
    context.on("requestfailed", (request) =>
      this.note({ kind: "failed", method: request.method(), url: request.url(), error: request.failure()?.errorText ?? "" }))
  }

  private watchPage(page: Page) {
    if (this.pages.has(page)) return
    this.pages.add(page)
    // Its console's errors and its uncaught errors, without a log: the test's own log records the lines it keeps.
    recordConsole(page, undefined, undefined, this)
  }

  /**
   * The check, at a test's teardown: appends the list to `log` (the test's browser.log, saved when it fails) and returns
   * each problem the test didn't declare, for `expect.soft(…, UNDECLARED).toEqual([])`.
   */
  check(testInfo: TestInfo, log: Array<string>): Array<string> {
    const environment = environmentAnnotations(lacks())
    const declared = [...testInfo.annotations, ...environment]
    if (environment.length > 0) log.push(`problems the environment declares: ${environment.map((each) => each.description).join(", ")}`)
    log.push(...this.report(declared))
    return this.undeclared(declared)
  }
}

export { UNDECLARED }

/**
 * The services a local dev server runs without (e2e/problems.ts `environmentAnnotations`): Code Storage and a model key
 * as their needs read them, and the GitHub App, set in this run's environment or the dev server's apps/mvp/.env. A
 * deployment lacks none.
 */
const lacks = () => {
  const local = target === "local"
  const githubApp = (process.env.GITHUB_APP_ID ?? "") !== "" || dotEnvSets(process.env.E2E_DOT_ENV ?? DOT_ENV, "GITHUB_APP_ID")
  return { codeStorage: local && !meets("codeStorage"), model: local && !meets("liveModel"), github: local && !githubApp }
}

/**
 * The test-scoped fixture both e2e/fixtures.ts and e2e/devices.ts extend with: the test's problems, watching every
 * context the worker's browser creates while the test runs.
 */
export const problems = [
  async ({ browser }: { browser: Browser }, use: (value: Watched) => Promise<void>) => {
    const watched = new Watched(new URL(baseURL).origin)
    const watch = (context: BrowserContext) => watched.watch(context)
    browser.on("context", watch)
    try {
      await use(watched)
    } finally {
      browser.off("context", watch)
    }
  },
  { scope: "test" },
] as const

const inTest = () => {
  try {
    base.info()
    return true
  } catch {
    return false
  }
}

const annotate = (annotation: { type: string; description: string }) => {
  const add = () => {
    const { annotations } = base.info()
    if (!annotations.some((each) => each.type === annotation.type && each.description === annotation.description)) annotations.push(annotation)
  }
  if (inTest()) add()
  else base.beforeEach(add)
}

/**
 * Declares that the test causes `status` on `path` on purpose (a fault-injection test): a response of `status`, or
 * `"failed"` for a request that got none. `*` in `path` stands for any characters. Called in a test's body, or in a file
 * or describe block for each of its tests. A 4xx needs it only for Chrome's console error about it.
 */
export const expectServerError = (status: Status, path: string) => annotate(serverErrorAnnotation(status, path))

/** Declares that the test causes a console or page error containing `text` on purpose. */
export const expectConsoleError = (text: string) => annotate(consoleErrorAnnotation(text))

/**
 * Playwright's own test with the check, for a spec that builds on it instead of e2e/fixtures.ts or e2e/devices.ts
 * (one that opens all its own contexts): each test fails on the problems it didn't declare, and a failing test's
 * browser.log keeps the list.
 */
export const strictTest = base.extend<{ problems: Watched; strict: void }>({
  problems: [...problems],
  strict: [
    async ({ problems }, use, testInfo) => {
      await use()
      if (testInfo.status === "skipped") return
      const log: Array<string> = []
      expect.soft(problems.check(testInfo, log), UNDECLARED).toEqual([])
      if (testInfo.status === testInfo.expectedStatus) return
      const path = testInfo.outputPath("browser.log")
      await appendFile(path, `${log.join("\n")}\n`)
      await testInfo.attach("browser-log", { path, contentType: "text/plain" })
    },
    { auto: true },
  ],
})

/**
 * Declares what a device the test takes offline logs (e2e/devices.ts `Device.offline`): each WebSocket that can't
 * connect, and, on a dev build, what the dev server's service worker never cached (it keeps only what a page it
 * controlled fetched): Vite's own client, and modules, workers and fonts no page fetched while online.
 */
export const expectOfflineErrors = () => {
  expectConsoleError("WebSocket connection to")
  if (!onThisMachine(baseURL)) return
  expectConsoleError("[vite] ")
  expectConsoleError("Failed to fetch dynamically imported module")
  // A code view's highlighter worker, whose script the dev server's worker never cached.
  expectConsoleError("Worker error: Event")
  expectConsoleError(" net::ERR_FAILED")
}
