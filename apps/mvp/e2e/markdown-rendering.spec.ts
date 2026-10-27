import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("repository README renders sanitized HTML and hides comments", async ({ page }) => {
  requires("codeStorage")
  await page.goto("/smithersai/smithers/blob/main/README.md")
  const preview = page.locator(".sui-markdown-editor[data-readonly]")
  await expect(preview.locator("pre")).toContainText("██", { timeout: 30_000 })
  await expect(preview.locator("strong")).toContainText("Automate maintaining your codebase")
  await expect(preview).not.toContainText("<!--")
  await expect(preview).not.toContainText('<pre align="center">')
  await expect(preview.locator("script, style, [onclick], [onerror]")).toHaveCount(0)
})

test("repository Markdown hides YAML metadata", async ({ page }) => {
  requires("codeStorage")
  await page.goto("/smithersai/smithers/blob/main/packages/smithers/flows/docs/quickstart.md")
  const preview = page.locator(".sui-markdown-editor[data-readonly]")
  await expect(preview.locator(".ProseMirror")).toBeVisible({ timeout: 30_000 })
  await expect(preview).not.toContainText("sidebar:")
  await expect(preview).not.toContainText('title: "Quickstart"')
  await expect(preview.getByRole("heading", { name: "Quickstart", exact: true })).toBeVisible()
})

test("phone tables scroll inside the document without splitting words", async ({ page }) => {
  requires("codeStorage")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/smithersai/smithers/blob/main/docs/design/agent-flow-health.md")
  const table = page.locator(".sui-markdown-editor .milkdown-table-block").first()
  await expect(table).toBeVisible({ timeout: 30_000 })
  expect(await table.evaluate(element => ({
    scrolls: element.scrollWidth > element.clientWidth,
    overflow: getComputedStyle(element).overflowX,
    layout: getComputedStyle(element.querySelector("table")!).tableLayout,
    words: getComputedStyle(element.querySelector("th")!).overflowWrap,
  }))).toEqual({ scrolls: true, overflow: "auto", layout: "auto", words: "normal" })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
