import { expect, test } from "./fixtures"
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
  const composer = page.getByRole("textbox", { name: "Message Smithers" })
  if (!(await composer.isVisible())) await page.getByRole("button", { name: /Chat/ }).click()
  await expect(composer).toBeEnabled()
  await controlled(page)
  if (!(await composer.isVisible())) await page.getByRole("button", { name: /Chat/ }).click()
  expectOfflineErrors()
  test.fail(browserName === "webkit", "Playwright WebKit setOffline blocks even a controlled precached document; real transport-drop coverage is required")
  await context.setOffline(true)
  const text = `webkit-device-storage-${crypto.randomUUID()}`
  await composer.fill(text)
  await composer.press("Enter")
  await expect(page.getByText(text, { exact: true })).toBeVisible()
  await expect(page.locator('[aria-label="Connection"]')).toContainText("1")
  await page.reload()
  if (!(await composer.isVisible())) await page.getByRole("button", { name: /Chat/ }).click()
  await expect(page.getByText(text, { exact: true })).toBeVisible()
  await expect(page.locator('[aria-label="Connection"]')).toContainText("1")
  // Stay offline until the context closes. Unlike devices.ts, this fixture
  // performs no answer-settlement POST during teardown.
})

test("conversations: stored rows survive an offline reload", async ({ page, context, browserName }) => {
  await page.goto("/app/conversations")
  const rows = page.getByRole("list", { name: "Conversations" }).getByRole("listitem")
  await expect(rows.first()).toBeVisible()
  await controlled(page)
  await expect(rows.first()).toBeVisible()
  const count = await rows.count()
  expectOfflineErrors()
  test.fail(browserName === "webkit", "Playwright WebKit setOffline blocks even a controlled precached document; real transport-drop coverage is required")
  await context.setOffline(true)
  await page.reload()
  await expect(rows).toHaveCount(count)
})
