import { expect, test, type Page } from "@playwright/test"
import { stubTutorialHost } from "./tutorial-stubs"

/*
 * Durable frame contract: the same card node expands in chat, frame identity
 * is addressable, browser history restores presentation, and a fork gets a
 * new branch without losing its source URL. The explicitly requested theme
 * picker provides a deterministic card without depending on repository I/O.
 */
test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the deterministic local-app lane")

const openWorkspaceChat = async (page: Page): Promise<void> => {
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  const chat = page.getByRole("button", { name: "Chat", exact: true })
  await expect(chat).toBeVisible()
  const skip = page.getByRole("button", { name: "Skip tutorial", exact: true })
  if (await skip.isVisible()) {
    await skip.click()
    await page.getByRole("button", { name: "Not now", exact: true }).click()
    await page.getByRole("button", { name: "Finish tutorial", exact: true }).click()
    await expect(page.getByRole("button", { name: "Finish tutorial", exact: true })).toHaveCount(0)
  }
}

const sendSlash = async (page: Page, line: string): Promise<void> => {
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await page.getByTestId("composer-input").fill(line)
  await page.getByTestId("composer-send").click()
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  await page.getByTestId("composer-input").press("Escape")
  await expect(page.getByTestId("composer-input")).toBeHidden()
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // A browser that denies storage is already an empty profile.
    }
  })
})

test("a tutorial Issue maximizes in place with one header, a viewport backdrop, scrolling and Escape restore", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await stubTutorialHost(page, baseURL!)
  await page.goto("/")
  await page.locator('.guide-actions [data-flow="issues.list"]').click()
  await page.locator('.guide-actions [data-flow="issues.view"]').click()
  await expect(page.getByRole("region", { name: "Lesson 3", exact: true })).toBeVisible()
  const card = page.locator('[data-tutorial-cards] .smithers-card[data-kind="issue"]')
  await expect(card).toBeVisible()
  const node = await card.elementHandle()
  await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await card.getByRole("button", { name: "Fork frame", exact: true }).click()
  await expect(page.locator(".toast-stack")).toContainText("Created Fork 1")
  await expect(page.locator(".card-maximize-backdrop:visible")).toHaveCount(1)
  await expect(card.locator(".smithers-card-header")).toHaveCount(1)
  await expect(card.getByRole("button", { name: "Back in frame", exact: true })).toHaveCount(1)
  await expect(card.getByRole("button", { name: "Previous frame", exact: true })).toHaveCount(0)
  await expect(card.locator(".smithers-card-details")).toHaveCount(0)
  await expect.poll(async () => {
    const box = await page.locator(".card-maximize-backdrop:visible").boundingBox()
    return box && { x: box.x, y: box.y, width: box.width, height: box.height }
  }).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
  const box = await card.boundingBox()
  expect(box!.height).toBeGreaterThan(700)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(800)
  // A long recorded issue must remain readable, with Restore reachable after scrolling.
  await page.setViewportSize({ width: 1280, height: 480 })
  await card.evaluate(element => { element.scrollTop = element.scrollHeight })
  expect(await card.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await expect(card.getByRole("button", { name: "Restore", exact: true })).toBeInViewport()
  await page.keyboard.press("Escape")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(card.getByRole("button", { name: "Maximize card", exact: true })).toBeFocused()
  expect(await card.evaluate((element, previous) => element === previous, node)).toBe(true)
  await expect(page.locator(".card-maximize-backdrop:visible")).toHaveCount(0)
})

test("clear archives locally and its recovery link restores the conversation after reload", async ({ page }) => {
  let summaryRequests = 0
  await page.route("**/api/model/stream", async (route) => {
    summaryRequests++
    await route.fulfill({ status: 503, body: "offline" })
  })
  await page.goto("/")
  await openWorkspaceChat(page)
  await sendSlash(page, "/appearance.theme")
  const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="theme-picker"]')
  await expect(card).toBeVisible()
  const cardId = await card.getAttribute("data-testid")
  const originalUrl = page.url()
  await sendSlash(page, "/chat.clear")
  await expect(page.getByRole("link", { name: "Open the archived conversation" })).toBeVisible()
  await expect(card).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await expect(page).not.toHaveURL(originalUrl)
  const newUrl = page.url()
  await page.reload()
  await page.getByRole("link", { name: "Open the archived conversation" }).click()
  await expect(page).toHaveURL(originalUrl)
  await expect(page.getByTestId(cardId!)).toBeVisible()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(newUrl)
  await expect(page.getByRole("link", { name: "Open the archived conversation" })).toBeVisible()
  expect(summaryRequests).toBe(0)
})

test("frame URLs survive reload, traverse history, preserve the card node, and fork", async ({ page }) => {
  await page.goto("/")
  await openWorkspaceChat(page)
  await sendSlash(page, "/appearance.theme")

  const card = page.locator('.smithers-card[data-kind="theme-picker"]')
  await expect(card).toBeVisible()
  const cardId = (await card.getAttribute("data-testid"))?.replace(/^card-/, "")
  expect(cardId).toBeTruthy()

  await card.evaluate((node) => {
    ;(node as HTMLElement & { frameIdentity?: string }).frameIdentity = "preserved"
  })
  await card.getByTestId(`card-maximize-${cardId}`).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toMatch(/^\/w\/workspace-main\/b\/branch-main\/f\/frame-card:branch-main:/)
  expect(await card.evaluate((node) =>
    (node as HTMLElement & { frameIdentity?: string }).frameIdentity
  )).toBe("preserved")

  const maximizedUrl = page.url()
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()

  await page.getByTestId("frame-back").click()
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe("/w/workspace-main/b/branch-main/f/frame-root:branch-main")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await page.goForward()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")

  await page.reload()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()

  await page.getByTestId("frame-fork").click()
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toMatch(/^\/w\/workspace-main\/b\/branch-[^/]+\/f\/frame-card:branch-[^:]+:/)
  await expect(page).not.toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")

  await page.goBack()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
})

test("open-in-tab returns the address bar to the root frame and Escape minimizes a pointer-maximized card", async ({ page }) => {
  await page.goto("/")
  await openWorkspaceChat(page)
  await sendSlash(page, "/appearance.theme")

  const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="theme-picker"]')
  await expect(card).toBeVisible()
  const cardId = (await card.getAttribute("data-testid"))?.replace(/^card-/, "")
  expect(cardId).toBeTruthy()

  // Escape after a pointer maximize: the pressed button unmounted, but focus followed to its replacement.
  await card.getByTestId(`card-maximize-${cardId}`).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await page.keyboard.press("Escape")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe("/w/workspace-main/b/branch-main/f/frame-root:branch-main")

  // Open in tab embeds the transcript's copy AND moves the address bar back to root, so reload keeps it embedded.
  await card.getByTestId(`card-maximize-${cardId}`).click()
  await page.getByTestId(`card-open-in-tab-${cardId}`).click()
  await expect(page.locator(".card-tab .smithers-card")).toBeVisible()
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toBe("/w/workspace-main/b/branch-main/f/frame-root:branch-main")
  await page.reload()
  await expect(page.locator('.smithers-card[data-kind="theme-picker"][data-maximized="true"]')).toHaveCount(0)
  await expect(page.locator(".card-maximize-backdrop")).toHaveCount(0)
})

test("booted from a repository path, the address bar keeps it while back and forward still switch frames", async ({ page }) => {
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.goto("/smithersai/smithers")
  const repoUrl = page.url()
  expect(new URL(repoUrl).pathname).toBe("/smithersai/smithers")
  await openWorkspaceChat(page)
  await sendSlash(page, "/appearance.theme")

  const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="theme-picker"]')
  await expect(card).toBeVisible()
  const cardId = (await card.getAttribute("data-testid"))?.replace(/^card-/, "")
  expect(cardId).toBeTruthy()
  await expect(page).toHaveURL(repoUrl)

  await card.getByTestId(`card-maximize-${cardId}`).click()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(page).toHaveURL(repoUrl)

  await page.goBack()
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(page).toHaveURL(repoUrl)
  await page.goForward()
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(page).toHaveURL(repoUrl)

  await page.reload()
  await expect(page).toHaveURL(repoUrl)
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible()
})
