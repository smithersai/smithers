import { expect, test } from "./fixtures"
import { requires, signedOut, syncedRepository } from "./target"

test.use(signedOut)
test("visitor issue counts settle without requesting private write history", async ({ page }, info) => {
  requires("syncedRepository")
  const sync: unknown[] = []
  page.on("response", response => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith("/api/shapes/")) return
    sync.push({ at: new Date().toISOString(), shape: url.pathname.split("/").at(-1),
      phase: url.searchParams.get("live") === "true" ? "live" : url.searchParams.get("offset") === "-1" ? "first" : "catch-up",
      status: response.status(), requestId: response.headers()["x-request-id"] })
  })
  const requests: string[] = []
  page.on("request", (request) => requests.push(new URL(request.url()).pathname))
  await page.goto(`/${syncedRepository()}/issues`)
  try {
    await expect(page.locator('[data-slot="issues-view"]')).toBeVisible({ timeout: 30_000 })
    // Absence before React mounts is not a settled list. The counts are the positive sync receipt.
    await expect(page.getByText(/\d+ open · \d+ closed/)).toBeVisible({ timeout: 60_000 })
    await expect(page.locator("[data-list-sync]")).toHaveCount(0)
    expect(requests).not.toContain("/api/shapes/github-writes")
  } finally {
    await info.attach("shape-responses", { body: JSON.stringify(sync, null, 2), contentType: "application/json" })
  }
})
