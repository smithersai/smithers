import { expect, test } from "./fixtures"
import { signedOut } from "./target"
import { expectConsoleError, expectServerError } from "./watch"

test.use(signedOut)
test("repository paths remain private in outgoing browser telemetry", async ({ page }) => {
  const marker = `bugbash4-bb5-app-private-${Date.now()}`
  const bodies: Array<string> = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/telemetry/")) bodies.push(request.postData() ?? "")
  })
  expectServerError(404, `/api/repos/${marker}/missing/*`)
  expectServerError(503, `/api/repos/${marker}/missing/*`)
  expectConsoleError("Failed to load resource: the server responded with a status of *")
  await page.goto(`/${marker}/missing`)
  await expect(page.getByRole("main")).toBeVisible()
  await expect.poll(() => bodies.length, { timeout: 30_000 }).toBeGreaterThan(0)
  await page.goto("/app")
  await expect.poll(() => bodies.some((body) => body.includes("url.path")), { timeout: 30_000 }).toBe(true)
  expect(bodies.join("\n")).not.toContain(marker)
  expect(bodies.join("\n")).toContain("/api/repos/:owner/:repo/")
})
