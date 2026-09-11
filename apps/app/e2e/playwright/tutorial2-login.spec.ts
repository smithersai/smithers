import { expect, test, type Page } from "@playwright/test"

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
  await page.context().route("**/api/auth/github/start?*", route => {
    if (host === "local") return route.fulfill({ contentType: "text/html", body: "GitHub handoff fixture" })
    signedIn = outcome === "success"
    const returnTo = new URL(route.request().url()).searchParams.get("return_to") ?? "/"
    return route.fulfill({ status: 302, headers: { location: `${returnTo}?${signedIn ? "signed-in=github" : "auth=failed"}` } })
  })
}
const signIn = async (page: Page) => {
  await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill("/auth.sign-in")
  await page.keyboard.press("Enter")
}
for (const host of ["local", "cloud"] as const) {
  test(`${host}: keyboard login preserves repo path and completes only after session validation`, async ({ page }) => {
    await setup(page, host)
    await page.goto("/will/tutorial")
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
    await expect(page.locator('[data-message-step="1"] .guide-step-done')).toHaveCount(0)
    await signIn(page)
    await expect(page.locator('[data-message-step="1"] .guide-step-done').first()).toBeVisible()
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2")
    expect(new URL(page.url()).pathname).toBe("/will/tutorial")
    await page.reload()
    await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "2")
  })
  for (const outcome of ["unknown", "unavailable", "cancelled", "501"]) {
    test(`${host}: ${outcome} never completes login`, async ({ page }) => {
      await setup(page, host, outcome)
      await page.goto("/will/tutorial")
      await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
      await signIn(page)
      await page.waitForTimeout(2500) // exceed the handoff poll and check animation window
      await expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", "1")
      await expect(page.locator('[data-message-step="1"] .guide-step-done')).toHaveCount(0)
      expect(new URL(page.url()).pathname).toBe("/will/tutorial")
    })
  }
}
