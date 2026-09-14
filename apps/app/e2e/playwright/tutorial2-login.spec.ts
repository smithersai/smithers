import { expect, test, type Page } from "@playwright/test"
import { stubTutorialHost } from "./tutorial-stubs"

// Contract fixtures exercise real boot, slash, handoff, persistence and guide
// producers. GitHub itself is external; no generic tutorial signal is injected.
const setup = async (page: Page, host: "local" | "cloud", outcome = "success") => {
  let signedIn = false
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host, version: "test", buildSha: "test", capabilities: ["identity"],
    authFlow: host === "local" ? "both" : "redirect", sandbox: null
  } }))
  await page.route("**/api/auth/session", route => route.fulfill({
    status: outcome === "501" ? 501 : 200,
    json: signedIn ? { status: "signed-in", login: "tutorial-user", allowlisted: true, admin: false }
      : outcome === "unknown" ? { status: "unknown", login: "tutorial-user" }
      : outcome === "unavailable" ? { status: "unavailable" }
      : { status: "signed-out" }
  }))
  await page.route("**/api/auth/scopes", route => route.fulfill({ json: { scopes: [{ plain: "Read your GitHub profile." }] } }))
  await page.route("**/api/auth/native/start", route => route.fulfill({ json: { handoffId: "tutorial", pollSecret: "fixture-only" } }))
  await page.route("**/api/auth/native/claim", route => {
    signedIn = outcome === "success"
    return route.fulfill({ json: { status: signedIn ? "ready" : "failed" } })
  })
  // With or without a query: from "/" the app sends no return_to at all.
  await page.context().route(/\/api\/auth\/github\/start(\?.*)?$/, route => {
    if (host === "local") return route.fulfill({ contentType: "text/html", body: "GitHub handoff fixture" })
    signedIn = outcome === "success"
    const returnTo = new URL(route.request().url()).searchParams.get("return_to") ?? "/"
    return route.fulfill({ status: 302, headers: { location: `${returnTo}?${signedIn ? "signed-in=github" : "auth=failed"}` } })
  })
}
/* Script v4: login is beat 10, after the practice repository; Skip practice (Q) goes straight to it. */
const skipPractice = async (page: Page) => {
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  await page.keyboard.press("q")
}
const signIn = async (page: Page) => {
  await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill("/auth.sign-in")
  await page.keyboard.press("Enter")
}
for (const host of ["local", "cloud"] as const) {
  test(`${host}: keyboard login returns to the same path and completes only after session validation`, async ({ page }) => {
    await setup(page, host)
    // A repository path (/owner/name) opens the repository app alone (AppIsland), so the tutorial lives on "/".
    await page.goto("/")
    await skipPractice(page)
    const before = new URL(page.url()).pathname
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "10")
    await expect(page.locator('[data-message-step="10"] .guide-step-done')).toHaveCount(0)
    await signIn(page)
    await expect(page.locator('[data-message-step="10"] .guide-step-done').first()).toBeVisible()
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "11")
    expect(new URL(page.url()).pathname).toBe(before)
    await page.reload()
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "11")
  })
  for (const outcome of ["unknown", "unavailable", "cancelled", "501"]) {
    test(`${host}: ${outcome} never completes login`, async ({ page }) => {
      await setup(page, host, outcome)
      // A repository path (/owner/name) opens the repository app alone (AppIsland), so the tutorial lives on "/".
    await page.goto("/")
    await skipPractice(page)
    const before = new URL(page.url()).pathname
      await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "10")
      await signIn(page)
      await page.waitForTimeout(2500) // exceed the handoff poll and check animation window
      await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "10")
      await expect(page.locator('[data-message-step="10"] .guide-step-done')).toHaveCount(0)
      expect(new URL(page.url()).pathname).toBe(before)
    })
  }
}

test("already installed: boot selects the latest pushed repository and completes without opening GitHub", async ({ page, baseURL }) => {
  const host = await stubTutorialHost(page, baseURL!)
  host.signedIn = true
  host.installed = true
  await page.route("**/api/user/github-app/installations**", route => route.fulfill({ json: { repos: [
    { fullName: "acme/older", pushedAt: "2026-08-01T00:00:00Z", installationId: 42 },
    { fullName: "acme/api", pushedAt: "2026-09-01T00:00:00Z", installationId: 42 }
  ] } }))
  await page.goto("/smithersai/smithers/")
  await page.getByTestId("chrome-account").focus()
  await page.keyboard.press("Enter")
  await expect(page.locator('[data-kind="account"]')).toBeVisible()
  await page.goto("/smithersai/smithers/?tutorial")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
  await expect(page.locator('.guide-transcript [data-kind="account"]')).toHaveCount(0)
  await skipPractice(page)
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "12")
  await expect(page.locator('.guide-transcript [data-kind="account"]')).toHaveCount(0)
  await page.getByTestId("chrome-account").focus()
  await page.keyboard.press("Enter")
  await expect(page.locator('.guide-transcript [data-kind="account"]')).toHaveCount(0)
  await expect(page.getByText("I can see acme/api.", { exact: true })).toBeVisible()
  expect(page.context().pages()).toHaveLength(1)
  expect(host.external()).toEqual([])
  await page.reload()
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "12")
  await expect(page.locator('.guide-transcript [data-kind="account"]')).toHaveCount(0)
})

test("several installations: the embedded chooser is keyboard operable and verifies the selection", async ({ page, baseURL }) => {
  const host = await stubTutorialHost(page, baseURL!)
  host.signedIn = true
  const verified: string[] = []
  await page.route("**/api/user/github-app/installations**", route => {
    const path = new URL(route.request().url()).pathname
    verified.push(path)
    const repos = [{ fullName: "ada/hello", installationId: 42 }, { fullName: "acme/api", installationId: 99 }]
    return route.fulfill({ json: { repos: path.endsWith("/99") ? [repos[1]] : repos } })
  })
  await page.goto("/")
  await skipPractice(page)
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "11")
  const chooser = page.locator("[data-tutorial-cards]")
  const select = chooser.getByTestId("flow-form-installationId")
  await expect(select).toBeVisible()
  await select.focus()
  await page.keyboard.press("a")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  // Native select selection is asserted before submitting through the keyboard door.
  await expect(select).toHaveValue("99")
  await chooser.getByRole("button", { name: /submit/i }).focus()
  await page.keyboard.press("Enter")
  await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "12")
  expect(verified).toContain("/api/user/github-app/installations/99")
  await expect(page.getByText("I can see acme/api.", { exact: true })).toBeVisible()
})

test("verification failure keeps Install and Later, and the pill rechecks without opening GitHub", async ({ page, baseURL }) => {
  const host = await stubTutorialHost(page, baseURL!)
  host.signedIn = true
  let reads = 0
  await page.route("**/api/user/github-app/installations**", route => {
    reads++
    return route.fulfill({ status: 409, json: { code: "request_conflict", message: "Your GitHub credential cannot access this repository." } })
  })
  await page.goto("/")
  await skipPractice(page)
  await expect(page.locator('[data-message-step="11"] [data-notice]')).toHaveText("Your GitHub credential cannot access this repository.")
  const before = reads
  await page.keyboard.press("a")
  await expect.poll(() => reads).toBeGreaterThan(before)
  await expect(page.locator('.guide-actions [data-flow="github.app.open"]')).toBeVisible()
  await expect(page.locator('.guide-actions [data-secondary]')).toContainText("Later")
  expect(page.context().pages()).toHaveLength(1)
})
