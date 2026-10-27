import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("phone docs: overflowing tables show a scroll cue and reveal the last column", async ({ page }) => {
  requires("docsSite")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/docs/reference/http-api/")
  const table = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Auth", exact: true }) }).first()
  const before = await table.evaluate(element => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
    shadows: getComputedStyle(element).backgroundImage,
    attachments: getComputedStyle(element).backgroundAttachment,
  }))
  expect(before.scroll).toBeGreaterThan(before.width)
  expect(before.shadows).toContain("radial-gradient")
  expect(before.attachments).toContain("local")
  await table.evaluate(element => { element.scrollLeft = element.scrollWidth })
  const auth = await table.getByRole("columnheader", { name: "Auth", exact: true }).boundingBox()
  expect(auth).not.toBeNull()
  expect(auth!.x).toBeGreaterThanOrEqual(0)
  expect(auth!.x + auth!.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
