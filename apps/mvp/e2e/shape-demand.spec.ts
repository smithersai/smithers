import type { Browser, Page } from "@playwright/test"
import { expect, step, test } from "./fixtures"
import { ShapeSync } from "./sync"
import { baseURL, requires, signedOut, target } from "./target"

// Which shapes a page follows (decision 0112). Every tab used to start every store's shape on boot: on 2026-10-26 a
// signed-out tab on smithers.sh/smithersai/smithers followed 18 shapes, 10 of them a person's own (empty for nobody),
// the triage settings, or a pull request's commits, reviews and checks, which only that pull request's page reads.
// With about 8 such tabs, the one Electric object answered "overloaded". Runs locally and against a deployment.

/** A person's own shapes and the repository's triage settings: none of them a signed-out page's. */
const PERSONAL = ["runs", "flows", "flow-drafts", "notifications", "my-conversations", "github-writes", "triage-settings"]
/** A pull request's own shapes: its page's, not the repository's. */
const DETAIL = ["pull-commits", "reviews", "checks"]

/** The shape routes `page` asks for, by name, and a wait until each it asked for is up to date. */
const follow = (page: Page) => {
  const sync = new ShapeSync()
  const routes = new Set<string>()
  page.on("request", (request) => {
    const { pathname } = new URL(request.url())
    if (pathname.startsWith("/api/shapes/")) routes.add(pathname.slice("/api/shapes/".length))
    sync.requested(request.url())
  })
  page.on("response", (response) => sync.answered(response.url(), response.status(), response.headers()))
  const settled = async () => {
    await expect(page.locator("main").first()).toBeVisible({ timeout: 60_000 })
    let seen = -1
    await expect(() => {
      const stable = sync.count === seen
      seen = sync.count
      expect(sync.behind(), "every shape the page asked for is up to date").toEqual([])
      expect(stable, "no new shape since the last look").toBe(true)
    }).toPass({ intervals: [1_000, 2_000], timeout: 90_000 })
  }
  return { routes, settled }
}

const asked = (routes: ReadonlySet<string>, names: ReadonlyArray<string>) => names.filter((name) => routes.has(name))

/** A fresh signed-out context, recording its video: no session, and locally the dev server told not to sign its person in. */
const signedOutPage = async (browser: Browser) => {
  const context = await browser.newContext({ ...signedOut, recordVideo: { dir: test.info().outputPath("videos") } })
  if (target === "local") {
    // Local development signs its person in unless told otherwise (worker/DevChatApi.ts).
    const secure = baseURL.startsWith("https:")
    await context.addCookies([{ name: `${secure ? "__Host-" : ""}smithers_dev_signed_out`, value: "1", url: baseURL, secure }])
  }
  return { context, page: await context.newPage() }
}

test.describe("shape demand", () => {
  // A repository's issues open with the page that reads them (decision 0079 slice 1b): its home asks for none.
  for (const path of ["/", "/smithersai/smithers/issues"] as const) {
    test(`${path}, signed out: no personal, admin or pull request shape`, {
      annotation: { type: "summary", description: `Signed out, ${path} asks for none of a person's shapes or a pull request's.` },
    }, async ({ browser }) => {
      // A repository's page reads its refs from Code Storage, which a local dev server reaches only with its keys.
      if (path !== "/") requires("codeStorage")
      test.setTimeout(180_000)
      const { context, page } = await signedOutPage(browser)
      try {
        const { routes, settled } = follow(page)
        await step(`Open ${path} signed out and let its shapes catch up`, async () => {
          await page.goto(path)
          await settled()
        })
        test.info().annotations.push({ type: "shapes", description: `${routes.size}: ${[...routes].sort().join(" ")}` })
        expect(asked(routes, [...PERSONAL, ...DETAIL])).toEqual([])
        if (path !== "/") expect(routes.has("items"), "the repository's own shapes still sync").toBe(true)
      } finally {
        await context.close()
      }
    })
  }

  test("/, signed in: a person's own shapes open, a pull request's don't", {
    annotation: { type: "summary", description: "Signed in, a person's own shapes sync; no pull request's without its page." },
  }, async ({ page }) => {
    test.setTimeout(180_000)
    const { routes, settled } = follow(page)
    await step("Open / signed in", async () => {
      await page.goto("/")
      await settled()
    })
    test.info().annotations.push({ type: "shapes", description: `${routes.size}: ${[...routes].sort().join(" ")}` })
    await expect.poll(() => asked(routes, ["runs", "flows", "flow-drafts", "my-conversations", "github-writes"]).length, { timeout: 30_000 }).toBe(5)
    expect(asked(routes, DETAIL)).toEqual([])
  })

  test("a pull request's page opens its commits, reviews and checks", {
    annotation: { type: "summary", description: "A pull request's commits, reviews and checks sync once its page opens." },
  }, async ({ page }) => {
    requires("codeStorage")
    test.setTimeout(180_000)
    const { routes, settled } = follow(page)
    await step("The pull requests' list asks for none of them", async () => {
      await page.goto("/smithersai/smithers/pulls")
      await settled()
      expect(asked(routes, DETAIL)).toEqual([])
    })
    await step("Its first pull request's page asks for all three", async () => {
      const first = page.locator('a[href*="/smithersai/smithers/pull/"]').first()
      await expect(first).toBeVisible({ timeout: 60_000 })
      await first.click()
      await expect.poll(() => asked(routes, DETAIL).sort(), { timeout: 60_000 }).toEqual([...DETAIL].sort())
    })
  })
})
