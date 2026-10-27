import { expect, test } from "./fixtures"
import { requires } from "./target"
import { expectServerError } from "./watch"

requires("member")
test("bug report: failed repository reads never expose repository or file paths in GitHub prefill", async ({ page }) => {
  for (const status of [400, 404, 502, 503] as const) expectServerError(status, "/api/repos/bugbash4-bb4-app2/*")
  await page.goto("/bugbash4-bb4-app2/private-repository")
  await expect(page.getByText(/Not found|No such repository|Couldn't|GitHub limit reached/).first()).toBeVisible({ timeout: 30_000 })
  await page.goto("/app/bugs/report")
  await page.getByRole("textbox", { name: "What happened?" }).fill("bugbash4-bb4-app2-private-read")
  await page.getByRole("button", { name: "Send", exact: true }).click()
  const link = page.getByRole("link", { name: "Open on GitHub", exact: true })
  await expect(link).toBeVisible({ timeout: 30_000 })
  const body = new URL((await link.getAttribute("href"))!).searchParams.get("body")!
  expect(body).toContain("Errors:")
  expect(body).not.toContain("/bugbash4-bb4-app2/")
  expect(body).not.toContain("private-repository")
})
