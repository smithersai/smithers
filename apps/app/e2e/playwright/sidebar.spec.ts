import { expect,test } from "@playwright/test"

test.use({ actionTimeout: 3_000, navigationTimeout: 10_000 })
test.setTimeout(30_000)

import { SCOPED_TEST_USER,signedOutVisitor } from "./identity"

test("the signed-in sidebar follows repository navigation and reload", async ({ page }) => {
  await signedOutVisitor(page)
  await page.route("**/api/auth/session", route => route.fulfill({ json: SCOPED_TEST_USER }))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.route("**/api/repos/smithersai/smithers", route => route.fulfill({ json: { default_bookmark: "main" } }))
  await page.route("**/api/repos/smithersai/smithers/contents", route => route.fulfill({ json: [{ name: "Cargo.toml", path: "Cargo.toml", type: "file" }] }))
  await page.route("**/api/user/repos", route => route.fulfill({ json: [
    { name: "canary-sandbox", owner: "codeplanesmithers", full_name: "codeplanesmithers/canary-sandbox" }
  ] }))
  await page.goto("/codeplanesmithers/canary-sandbox/")
  const logo = page.getByRole("button", { name: "Smithers", exact: true })
  await logo.click()
  const sidebar = page.locator("#session-sidebar")
  await expect(sidebar).toContainText("canary-sandbox")
  await page.goto("/smithersai/smithers/")
  await logo.click()
  await expect(sidebar).toContainText("Cargo.toml")
  await expect(sidebar).not.toContainText("canary-sandbox")
  await page.reload()
  await logo.click()
  await expect(sidebar).toContainText("smithersai/")
  await expect(sidebar).not.toContainText("canary-sandbox")
})
