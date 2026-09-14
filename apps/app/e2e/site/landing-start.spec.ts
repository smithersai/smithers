import { expect, test } from "@playwright/test"

test("Start Here mounts the real island in place when it loads", async ({ page }) => {
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test", capabilities: [], authFlow: "none", sandbox: null,
  } }))
  await page.goto("/")
  await page.getByRole("link", { name: "Start Here", exact: true }).click()
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  await expect(page).toHaveURL("/")
  await expect(page.locator("#start-error")).toHaveCount(0)
})

for (const failure of ["chunk", "page"] as const) {
  test(`Start Here reports an aborted app ${failure} and Reload reloads the document`, async ({ page }) => {
    let aborted = 0
    const route = failure === "chunk" ? /\/_astro\/AppIsland\.[^/]+\.js$/ : /\/smithersai\/smithers\/\?tutorial$/
    await page.route(route, request => { aborted++; return request.abort() })
    await page.goto("/")
    const start = page.getByRole("link", { name: "Start Here", exact: true })
    await expect(start).toBeVisible()
    if (failure === "chunk") await page.keyboard.press("s")
    else await start.click()
    await expect(page.getByRole("alert")).toHaveText("Smithers couldn't load. Reload to try again.")
    expect(aborted).toBeGreaterThan(0)
    await expect(start).toBeHidden()
    await expect(page.locator("#start")).not.toHaveAttribute("aria-busy")
    await expect(page.locator(".guide-shell")).toHaveCount(0)
    await expect(page).toHaveURL("/")
    const reload = page.getByRole("button", { name: "Reload", exact: true })
    await expect(reload).toBeFocused()
    await page.screenshot({ path: test.info().outputPath("load-error.png") })
    await Promise.all([
      page.waitForEvent("request", request => request.isNavigationRequest() && request.frame() === page.mainFrame()),
      page.keyboard.press("Enter"),
    ])
    await page.waitForLoadState()
    await expect(page.getByRole("alert")).toBeHidden()
    await expect(start).toBeVisible()
    expect(await page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming).type)).toBe("reload")
  })
}

test("a returning entry reveals the landing error if its preloaded island fails", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("smithers-mvp.persistenceBackend", "sqlite"))
  await page.route(/\/_astro\/AppIsland\.[^/]+\.js$/, request => request.abort())
  await page.goto("/")
  await expect(page.getByRole("alert")).toHaveText("Smithers couldn't load. Reload to try again.")
  await expect(page.getByRole("button", { name: "Reload", exact: true })).toBeVisible()
  await expect(page.locator("main.home")).toHaveCSS("visibility", "visible")
})

test.describe("touch landing", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } })
  test("Start Here hides the physical key chip on a coarse pointer", async ({ page }) => {
    await page.route(/\/smithersai\/smithers\/\?tutorial$/, request => request.abort())
    await page.goto("/")
    await expect(page.locator("#start")).toBeVisible()
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
    await expect(page.locator("#start kbd")).toBeHidden()
  })
})
