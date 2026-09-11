import { expect, test } from "@playwright/test"

test("the split SQLite worker boots with OPFS and preserves a composer draft across reload", async ({ page }) => {
  const errors: string[] = []
  const wasm: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.context().on("request", (request) => {
    if (/\/wa-sqlite-[^/]+\.wasm$/.test(request.url())) wasm.push(request.url())
  })
  await page.goto("/")
  await expect(page.locator(".guide-shell")).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  expect(wasm.length).toBeGreaterThan(0)
  await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill("A durable cold-load draft")
  // The next command is serialized after the draft's persistence transaction.
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.reload()
  await expect(page.locator(".guide-shell")).toBeVisible()
  await page.keyboard.press("Control+k")
  await expect(page.getByTestId("composer-input")).toHaveValue("A durable cold-load draft")
  expect(await page.evaluate(() => localStorage.getItem("smithers-mvp.persistenceBackend"))).toBe("opfs")
  expect(errors).toEqual([])
})
