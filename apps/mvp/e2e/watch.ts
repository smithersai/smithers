import { type Browser, type BrowserContext, expect, test as base, type Page, type Request, type TestInfo } from "@playwright/test"
import { appendFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { recordConsole } from "./console"
import { accessControlURL, DocumentRequests } from "./cancellations"
import { consoleErrorAnnotation, environmentAnnotations, pathOf, Problems, serverErrorAnnotation, type Observation, type Status, UNDECLARED } from "./problems"
import { baseURL, DOT_ENV, dotEnvSets, meets, onThisMachine, target } from "./target"

// Every browser context a test opens is watched from its first request (docs/infrastructure.md#server-and-console-errors):
// its pages' responses and failed requests, and their console and page errors, go to the test's Problems
// (e2e/problems.ts). The default page's context, each device's (e2e/devices.ts) and any a test opens itself
// (`browser.newContext()`) alike. At teardown a test fails on each problem it didn't declare.

/** A test's problems, fed by every context it opens. */
export class Watched extends Problems {
  private readonly contexts = new WeakSet<BrowserContext>()
  private readonly pages = new WeakSet<Page>()
  private readonly cancellationRecords: string[] = []
  private readonly nativeCandidates: Array<{ observation: Observation; classify: (() => boolean) | undefined; receipt: string }> = []
  private readonly documents = new WeakMap<Page, DocumentRequests>()
  private readonly requestIds = new WeakMap<Request, number>()
  private requestSequence = 0

  private document(page: Page): DocumentRequests {
    let history = this.documents.get(page)
    if (history === undefined) {
      history = new DocumentRequests()
      this.documents.set(page, history)
    }
    return history
  }

  private trace(request: Request) {
    try {
      const frame = request.frame()
      const page = frame.page()
      let id = this.requestIds.get(request)
      if (id === undefined) this.requestIds.set(request, id = ++this.requestSequence)
      return { frame, page, id, history: this.document(page) }
    } catch {
      // Worker-owned requests may have no page. They never establish a page's cancellation witness.
      return undefined
    }
  }

  /** Watches `context` and its pages from now on; watching one twice changes nothing. */
  watch(context: BrowserContext): void {
    if (this.contexts.has(context)) return
    this.contexts.add(context)
    context.on("page", (page) => this.watchPage(page))
    for (const page of context.pages()) this.watchPage(page)
    context.on("request", request => {
      const trace = this.trace(request)
      if (request.isNavigationRequest()) this.cancellationRecords.push(`navigation start ${new Date().toISOString()} ${pathOf(request.url())} tracked=${trace !== undefined}`)
      if (trace === undefined) return
      if (request.isNavigationRequest() && trace.frame === trace.page.mainFrame()) {
        const from = request.redirectedFrom()
        trace.history.navigate(trace.id, Date.now(), from === null ? undefined : this.requestIds.get(from))
      }
      const url = new URL(request.url())
      if (url.origin === this.origin && !request.isNavigationRequest()) trace.history.start(trace.id, request.url(), Date.now())
    })
    context.on("response", response => {
      this.note({ kind: "response", method: response.request().method(), url: response.url(), status: response.status() })
      const trace = this.trace(response.request())
      trace?.history.response(trace.id, response.status())
    })
    context.on("requestfinished", request => {
      const trace = this.trace(request)
      trace?.history.finish(trace.id)
    })
    context.on("requestfailed", (request) => {
      const error = request.failure()?.errorText ?? ""
      this.note({ kind: "failed", method: request.method(), url: request.url(), error })
      const trace = this.trace(request)
      trace?.history.fail(trace.id, error, Date.now())
      if (trace !== undefined && request.isNavigationRequest() && trace.frame === trace.page.mainFrame()) trace.history.abort(trace.id, Date.now())
      if (new URL(request.url()).origin === this.origin) this.cancellationRecords.push(
        `requestfailed ${new Date().toISOString()} ${pathOf(request.url())} key=${createHash("sha256").update(request.url()).digest("hex").slice(0, 16)} ${error}`,
      )
    })
  }

  private watchPage(page: Page) {
    if (this.pages.has(page)) return
    this.pages.add(page)
    const history = this.document(page)
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) {
        this.cancellationRecords.push(`navigation commit ${new Date().toISOString()} ${pathOf(frame.url())}`)
        const revision = history.documentEvent(Date.now())
        void frame.evaluate(() => {
          const document = window as Window & { __smithersE2EDocument?: string }
          return document.__smithersE2EDocument ??= crypto.randomUUID()
        }).then(identity => history.observeDocument(revision, identity), () => {
          // A disappearing context leaves identity unknown; it cannot establish cancellation evidence.
          this.cancellationRecords.push(`document identity unavailable ${new Date().toISOString()}`)
        })
      }
    })
    // Its console's errors and its uncaught errors, without a log: the test's own log records the lines it keeps.
    recordConsole(page, undefined, undefined, { note: (observation) => {
      if (observation.kind === "page" && observation.name === `Fetch API cannot load ${new URL(this.origin).protocol.slice(0, -1)}` &&
        page.context().browser()?.browserType().name() === "webkit" && observation.text.endsWith(" due to access control checks.")) {
        const url = accessControlURL(this.origin, observation.text)
        if (url !== undefined) {
          const at = Date.now()
          this.nativeCandidates.push({
            observation, classify: history.candidate(url, at),
            receipt: `${new Date(at).toISOString()} ${pathOf(url)} key=${createHash("sha256").update(url).digest("hex").slice(0, 16)} navigation=${JSON.stringify(history.progress())} witness=${JSON.stringify(history.witness(url, at))}`,
          })
          return
        }
      }
      this.note(observation)
    } })
  }

  /** The real-browser regression requires this native diagnostic and its cancellation/navigation ordering. */
  navigationCancellations(): readonly string[] {
    return this.nativeCandidates.filter(candidate => candidate.classify?.() === true).map(candidate => candidate.receipt)
  }

  /**
   * The check, at a test's teardown: appends the list to `log` (the test's browser.log, saved when it fails) and returns
   * each problem the test didn't declare, for `expect.soft(…, UNDECLARED).toEqual([])`.
   */
  check(testInfo: TestInfo, log: Array<string>): Array<string> {
    for (const candidate of this.nativeCandidates.splice(0)) {
      const cancelled = candidate.classify?.() === true
      this.cancellationRecords.push(`${cancelled ? "navigation cancellation" : "access-control"} ${candidate.receipt}`)
      if (!cancelled) this.note(candidate.observation)
    }
    const environment = environmentAnnotations(lacks())
    const declared = [...testInfo.annotations, ...environment]
    log.push(...this.cancellationRecords)
    if (environment.length > 0) log.push(`problems the environment declares: ${environment.map((each) => each.description).join(", ")}`)
    log.push(...this.report(declared))
    const undeclared = this.undeclared(declared)
    if (undeclared.length > 0 && this.cancellationRecords.length > 0) console.info(`Network cancellation witnesses:\n${this.cancellationRecords.join("\n")}`)
    return undeclared
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
