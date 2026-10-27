import { expect, test } from "./fixtures"
import { showChat } from "./chat-composer"
import { ownPlace, requires } from "./target"
import { expectOfflineErrors } from "./watch"

requires("member", "ownConversation")

const controlled = async (page: import("@playwright/test").Page) => {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
}

test("chat and outbox: an offline question survives reload without sending", async ({ page, context, browserName }) => {
  await page.goto(ownPlace()?.path ?? "/app")
  const composer = await showChat(page)
  await expect(composer).toBeEnabled()
  await controlled(page)
  await showChat(page)
  expectOfflineErrors()
  test.fail(browserName === "webkit", "Playwright WebKit setOffline blocks even a controlled precached document; real transport-drop coverage is required")
  await context.setOffline(true)
  const text = `bugbash4-w13f-device-storage-${crypto.randomUUID()}`
  await composer.fill(text)
  await composer.press("Enter")
  await expect(page.getByText(text, { exact: true })).toBeVisible()
  await expect(page.locator('[aria-label="Connection"]')).toContainText("1")
  await page.reload()
  // Reopening need not offer a composer while sign-in is offline. The stored
  // question and queued count, rather than another input, prove retention.
  await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[aria-label="Connection"]')).toContainText("1")
  // Stay offline until the context closes. Unlike devices.ts, this fixture
  // performs no answer-settlement POST during teardown.
})

test("conversations: stored rows survive an offline reload", async ({ page, context, browserName }) => {
  // Tracking through the page records an opened conversation; setup's API track
  // only establishes the branch, and promises no row in the person's recent list.
  const path = ownPlace()?.path ?? "/octocat/Spoon-Knife/tree/main"
  await page.goto(path)
  await showChat(page)
  await page.goto("/app/conversations")
  const rows = page.getByRole("list", { name: "Conversations" }).getByRole("listitem")
  await expect(page.getByRole("list", { name: "Conversations" }).locator(`a[href="${path}"]`)).toBeVisible({ timeout: 30_000 })
  await controlled(page)
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  const links = await rows.getByRole("link").evaluateAll((elements) => elements.map((element) => element.getAttribute("href")))
  expectOfflineErrors()
  test.fail(browserName === "webkit", "Playwright WebKit setOffline blocks even a controlled precached document; real transport-drop coverage is required")
  await context.setOffline(true)
  await page.reload()
  await expect(rows).toHaveCount(links.length, { timeout: 30_000 })
  expect(await rows.getByRole("link").evaluateAll((elements) => elements.map((element) => element.getAttribute("href")))).toEqual(links)
})
