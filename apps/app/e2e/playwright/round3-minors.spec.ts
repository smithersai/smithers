import { expect,test } from "@playwright/test"
import { stubTutorialHost } from "./tutorial-stubs"

test("an unknown repository opens its recovery notice near the header", async ({ page, baseURL }) => {
  await stubTutorialHost(page, baseURL!)
  await page.goto("/nope/nope/")
  const notice = page.locator('[data-repository-missing] .smithers-chat-message')
  await expect(notice).toBeVisible()
  expect((await notice.boundingBox())!.y).toBeLessThan(180)
  await expect(notice.locator('[data-flow="auth.sign-in"]')).toBeInViewport()
})

test("an unknown repository opens its recovery notice after a known repository in the same page", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await stubTutorialHost(page, baseURL!)
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.route("**/api/repos/smithersai/smithers", route => route.fulfill({ json: { default_bookmark: "main" } }))
  await page.route("**/contents/.smithers/home.json", route => route.fulfill({ json: {
    content: JSON.stringify({ blocks: [{ type: "text", text: "The known repository's home." }] })
  } }))

  await page.goto("/smithersai/smithers/")
  const home = page.locator('[data-kind="repo-home"] .smithers-card-title')
  await expect(home).toHaveText("Home · smithersai/smithers")
  await expect(home).toBeInViewport()
  await page.goto("/nope/nope/")
  const notice = page.locator('[data-repository-missing] .smithers-chat-message')
  await expect(notice).toContainText("nope/nope isn't on Smithers yet.")
  expect((await notice.boundingBox())!.y).toBeLessThan(180)
  await expect(notice.locator('[data-flow="auth.sign-in"]')).toBeInViewport()
  await expect(home).toHaveCount(0)
  await expect(page).toHaveURL(/\/nope\/nope\/$/)

  await notice.getByRole("link", { name: "smithersai/smithers", exact: true }).click()
  await expect(home).toBeInViewport()
  await expect(page.locator('[data-repository-missing]')).toHaveCount(0)
})
