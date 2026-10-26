import type { Browser, BrowserContext, Page, TestInfo } from "@playwright/test"
import { recordConsole } from "./console"
import { expect, recordActions, step, test, themeOf } from "./fixtures"
import { ShapeSync } from "./sync"
import { baseURL, requires, signedOut, target } from "./target"

// Production health (Will, 2026-10-25 18:50: "Please make sure we are testing production works"). He opened
// smithers.sh and his console showed shape reads answered 500, which no spec had failed on: the browser retries a shape,
// and the specs checked only what rendered in the end. Each case cold-loads a page in eight fresh browsers at once,
// signed out and signed in, and waits until every shape each page asked for is up to date (e2e/sync.ts). The test's
// check (e2e/watch.ts) fails it on any response of 500 or above, failed /api/ request, console error or page error,
// and this spec declares none. It runs locally and against a deployment, and is the first spec to run after a deploy
// (docs/infrastructure.md#deploy).

const PAGES = ["/", "/smithersai/smithers", "/smithersai/vibelang"] as const
const BROWSERS = 8
const VIEWPORT = { width: 1280, height: 800 }

type Who = "signed out" | "signed in"

/**
 * A fresh browser context, as a first visit has: no cookies but the run's session when signed in (a deployment's stored
 * session, local development's person locally), no service worker, no stored data. The first records its video.
 */
const fresh = async (browser: Browser, testInfo: TestInfo, who: Who, n: number): Promise<BrowserContext> => {
  const context = await browser.newContext({
    ...(who === "signed out" ? signedOut : {}),
    viewport: VIEWPORT,
    colorScheme: themeOf(testInfo),
    ...(n === 1 ? { recordVideo: { dir: testInfo.outputPath(`browser-${n}`), size: VIEWPORT } } : {}),
  })
  if (who === "signed out" && target === "local") {
    // Local development signs its person in unless told otherwise (worker/DevChatApi.ts).
    const secure = baseURL.startsWith("https:")
    await context.addCookies([{ name: `${secure ? "__Host-" : ""}smithers_dev_signed_out`, value: "1", url: baseURL, secure }])
  }
  return context
}

/** Waits until `page` has opened `path` and every shape it asked for is up to date: twice in a row, none new between. */
const settled = async (page: Page, sync: ShapeSync) => {
  await expect(page.locator("main").first(), "the page opens").toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole("progressbar", { name: "Loading page" }), "the page finished loading").toHaveCount(0, { timeout: 60_000 })
  let seen = -1
  await expect(() => {
    const count = sync.count
    const stable = count === seen
    seen = count
    expect(sync.behind(), "every shape the page asked for is up to date").toEqual([])
    expect(stable, "no new shape since the last look").toBe(true)
  }).toPass({ intervals: [500, 1_000], timeout: 90_000 })
}

const open = (browser: Browser, testInfo: TestInfo, log: Array<string>, who: Who, path: string, n: number) =>
  step(`Browser ${n} opens ${path}, ${who}, and its shapes catch up`, async () => {
    const context = await fresh(browser, testInfo, who, n)
    const page = await context.newPage()
    await recordActions(page, testInfo, `Browser ${n}`)
    // The first browser's whole console goes to the test's browser.log, which a failing test keeps.
    if (n === 1) recordConsole(page, log, () => "browser 1: ")
    const sync = new ShapeSync()
    page.on("request", (request) => sync.requested(request.url()))
    page.on("response", (response) => sync.answered(response.url(), response.status(), response.headers()))
    await page.goto(path)
    await settled(page, sync)
    return context
  })

test.describe("health: a cold load in eight browsers at once", () => {
  for (const who of ["signed out", "signed in"] as const) {
    for (const path of PAGES) {
      test(
        `${path}, ${who}: no server error, failed request, console error or page error`,
        {
          annotation: {
            type: "summary",
            description: `Eight fresh browsers open ${path} ${who} at once; every shape catches up with no error anywhere.`,
          },
        },
        async ({ browser, browserLog }, testInfo) => {
          // A repository's page reads its refs from Code Storage, which a local dev server reaches only with its keys:
          // without them the read answers 503 not_configured (worker/RepoApi.ts).
          if (path !== "/") requires("codeStorage")
          test.setTimeout(240_000)
          const contexts = await Promise.all(Array.from({ length: BROWSERS }, (_, index) => open(browser, testInfo, browserLog, who, path, index + 1)))
          // The check at teardown reads every context's responses, requests, console and page errors.
          await Promise.all(contexts.map((context) => context.close()))
        },
      )
    }
  }
})
