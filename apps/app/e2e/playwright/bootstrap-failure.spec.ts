import { expect, test } from "@playwright/test"

for (const [kind, fulfill] of [
  ["unreachable", async (route: import("@playwright/test").Route) => route.abort("failed")],
  ["missing", async (route: import("@playwright/test").Route) => route.fulfill({ status: 404, body: "404" })],
  ["server", async (route: import("@playwright/test").Route) => route.fulfill({ status: 503, body: "bad gateway" })],
  ["invalid", async (route: import("@playwright/test").Route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })]
] as const) {
  test(`real web app recovers from ${kind} bootstrap`, async ({ page }) => {
    await page.route("**/api/bootstrap", fulfill)
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "Backend unavailable" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible()
    await page.getByRole("button", { name: "Switch backend" }).click()
    await expect(page.getByRole("textbox", { name: "Backend URL" })).toBeVisible()
    await expect(page.locator("main")).not.toContainText("404")
    if (kind === "missing") {
      await page.unroute("**/api/bootstrap", fulfill)
      await page.getByRole("textbox", { name: "Backend URL" }).fill(new URL(page.url()).origin)
      await page.getByRole("button", { name: "Connect" }).click()
      await expect(page.getByRole("heading", { name: "Backend unavailable" })).toHaveCount(0)
    }
  })
}
