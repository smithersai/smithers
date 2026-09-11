import { expect, test } from "@playwright/test"

/*
 * Durable frame contract: the same card node expands in chat, frame identity
 * is addressable, browser history restores presentation, and a fork gets a
 * new branch without losing its source URL. The explicitly requested theme
 * picker provides a deterministic card without depending on repository I/O.
 */
test.skip(process.env.SMITHERS_CHAT_STUB === "0", "the deterministic local-app lane")

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // A browser that denies storage is already an empty profile.
    }
  })
})

test("clear archives locally and its recovery link restores the conversation after reload", async ({ page }) => {
  let summaryRequests = 0
  await page.route("**/api/model/stream", async (route) => {
    summaryRequests++
    await route.fulfill({ status: 503, body: "offline" })
  })
  await page.goto("/")
  await page.getByTestId("composer-input").fill("/appearance.theme")
  await page.getByTestId("composer-send").click()
  const card = page.getByTestId("transcript").locator('.smithers-card[data-kind="theme-picker"]')
  await expect(card).toBeVisible()
  const cardId = await card.getAttribute("data-testid")
  const originalUrl = page.url()
  await page.getByTestId("composer-input").fill("/chat.clear")
  await page.getByTestId("composer-send").click()
  await expect(page.getByRole("link", { name: "Open the archived conversation" })).toBeVisible()
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await expect(page).not.toHaveURL(originalUrl)
  const newUrl = page.url()
  await page.reload()
  await page.getByRole("link", { name: "Open the archived conversation" }).click()
  await expect(page).toHaveURL(originalUrl)
  await expect(page.getByTestId(cardId!)).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(newUrl)
  await expect(page.getByRole("link", { name: "Open the archived conversation" })).toBeVisible()
  expect(summaryRequests).toBe(0)
})

test("frame URLs survive reload, traverse history, preserve the card node, and fork", async ({ page }) => {
  await page.goto("/")
  await page.getByTestId("composer-input").fill("/appearance.theme")
  await page.getByTestId("composer-send").click()

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
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await page.getByTestId("composer-input").click()

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
  await expect(page.getByTestId("composer-input")).toBeVisible()

  await page.getByTestId("frame-fork").click()
  await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname))
    .toMatch(/^\/w\/workspace-main\/b\/branch-[^/]+\/f\/frame-card:branch-[^:]+:/)
  expect(page.url()).not.toBe(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")

  await page.goBack()
  await expect(page).toHaveURL(maximizedUrl)
  await expect(card).toHaveAttribute("data-maximized", "true")
})

test("open-in-tab returns the address bar to the root frame and Escape minimizes a pointer-maximized card", async ({ page }) => {
  await page.goto("/")
  await page.getByTestId("composer-input").fill("/appearance.theme")
  await page.getByTestId("composer-send").click()

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
  // The local origin carries no public catalog; the pinned address bar does not depend on the selection.
  await page.route("**/api/public/repos", (route) => route.fulfill({ status: 404, body: "no catalog" }))
  await page.goto("/smithersai/smithers")
  const repoUrl = page.url()
  expect(new URL(repoUrl).pathname).toBe("/smithersai/smithers")
  await page.getByTestId("composer-input").fill("/appearance.theme")
  await page.getByTestId("composer-send").click()

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
  await expect(page.getByTestId("composer-input")).toBeVisible()
})
