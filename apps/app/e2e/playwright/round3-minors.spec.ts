import { expect, test } from "@playwright/test"
import { stubTutorialHost } from "./tutorial-stubs"

// Exercise the reported surfaces through their existing public controls.
test("issue actions, form titles, flow names and fork feedback stay readable", async ({ page, baseURL }) => {
  await stubTutorialHost(page, baseURL!)
  await page.goto("/?tutorial")
  await page.locator('.guide-actions [data-flow="issues.list"]').click()
  await page.locator('.guide-actions [data-flow="issues.view"]').click()
  const issue = page.locator('[data-tutorial-cards] .smithers-card[data-kind="issue"]')
  const linear = issue.locator('[data-flow="issues.link-linear"]')
  await expect(linear).toHaveClass(/sui-button-outline/)
  await expect(linear).toHaveCSS("border-top-style", "solid")
  await issue.getByRole("button", { name: "Maximize card", exact: true }).click()
  await issue.getByRole("button", { name: "Fork frame", exact: true }).click()
  await expect(page.locator('.toast-stack .toast[role="status"]')).toContainText("Created Fork 1")
  await issue.getByRole("button", { name: "Restore", exact: true }).click()
  await issue.locator('[data-flow="issue.add-flow"]').click()
  await expect(page.locator('.guide-transcript [data-kind="flow-form"] .smithers-card-title')).toHaveText("Add a flow to issue #3")
  await issue.locator('[data-flow="issue.flows"]').click()
  await expect(page.locator('.guide-transcript .workflow-list-text > strong')).toHaveText("Research and reproduce before implementation")
})

test.describe("phone help", () => {
  test.use({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, colorScheme: "light" })
  test("the chat help clears the goal and touch Chat keeps a visible close control", async ({ page, baseURL }) => {
    await stubTutorialHost(page, baseURL!)
    await page.goto("/?tutorial")
    // The first introduction anchors to the suggested action; Next moves it to Chat.
    await page.locator("[data-guidance-next]").click()
    const help = page.locator('.guide-chat-controls .help-bubble')
    await expect(help).toBeVisible({ timeout: 20_000 })
    await expect(help).toHaveCSS("background-color", "rgb(247, 246, 241)")
    const goal = await page.locator('.guide-goal').boundingBox()
    const bubble = await help.boundingBox()
    expect(bubble!.y).toBeGreaterThanOrEqual(goal!.y + goal!.height)
    expect(bubble!.height).toBeGreaterThan(40)
    await page.locator('.guide-chat-controls [data-flow="chat.open"]').click()
    await expect(page.locator('[data-ask] .slash-menu-description')).toContainText("tap to send")
    await page.getByRole("button", { name: "Close Chat", exact: true }).click()
    await expect(page.locator('.guide-shell')).toHaveAttribute("data-conversation-open", "false")
  })
})

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
