import { expect, test } from "./fixtures"
import { showChat } from "./chat-composer"
import { requires } from "./target"
import { expectServerError } from "./watch"

requires("member")
test("bug report: failed repository reads never expose repository or file paths in GitHub prefill", async ({ page }) => {
  for (const status of [400, 404, 502, 503] as const) expectServerError(status, "/api/repos/bugbash4-w13f-private/*")
  // The home conversation may preload a repository before the composer appears.
  // Observe from the first request, including a failed read the navigation reuses.
  const read = page.waitForResponse((response) => new URL(response.url()).pathname ===
    "/api/repos/bugbash4-w13f-private/private-repository/about" && response.status() >= 400)
  await page.goto("/app")
  const composer = await showChat(page)
  await expect(composer).toBeEnabled({ timeout: 30_000 })
  await composer.fill("/navigate /bugbash4-w13f-private/private-repository")
  await composer.press("Enter")
  await expect(page).toHaveURL(/\/bugbash4-w13f-private\/private-repository$/)
  const failed = await read
  expect([400, 404, 502, 503]).toContain(failed.status())
  await failed.finished()
  // The report captures this tab's records. A full navigation destroys those records;
  // use browser history so the failed read is actually in the prefill. Back to
  // chat deliberately adds an embed; this diagnostic must leave no broken embed.
  await page.goBack()
  await expect(page).toHaveURL(/\/app$/)
  await page.getByRole("button", { name: "Report a bug", exact: true }).click({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/app\/bugs\/report$/)
  await page.getByRole("textbox", { name: "What happened?" }).fill("bugbash4-w13f-private-read")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const link = page.getByRole("link", { name: "Open on GitHub", exact: true })
  await expect(link).toBeVisible({ timeout: 30_000 })
  const body = new URL((await link.getAttribute("href"))!).searchParams.get("body")!
  expect(body).toContain("Errors:")
  expect(body).toContain("Page: app")
  // A 404 records the failed repo/about flow without an HTTP error route.
  // Require that failure too, so the privacy check cannot pass with no diagnostics.
  expect(body).toMatch(/^Failures:.*\brepo\/about\b/m)
  expect(body).not.toContain("/bugbash4-w13f-private/")
  expect(body).not.toContain("private-repository")
})
