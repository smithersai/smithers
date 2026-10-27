import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("repository README renders sanitized HTML and hides comments", async ({ page }) => {
  requires("codeStorage")
  await page.goto("/smithersai/smithers/blob/main/README.md")
  const preview = page.locator(".sui-markdown-editor[data-readonly]")
  await expect(preview.locator(".sui-markdown-html pre")).toContainText("██", { timeout: 30_000 })
  await expect(preview.locator("strong").filter({ hasText: "Automate maintaining your codebase" })).toHaveText("Automate maintaining your codebase")
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
  await expect(preview.getByRole("heading", { name: "Prerequisites", exact: true })).toBeVisible()
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

test("issue code fences have language colors", async ({ page }) => {
  await page.goto("/smithersai/smithers/issues/4255")
  await expect(page.locator('[data-slot="markdown"] .sui-rh-tok-keyword').first()).toBeVisible({ timeout: 30_000 })
})

test("repository README draws GitHub warning alerts", async ({ page }) => {
  requires("codeStorage")
  await page.goto("/smithersai/vibelang/blob/main/README.md")
  const preview = page.locator(".sui-markdown-editor[data-readonly]")
  await expect(preview.locator('.sui-markdown-alert-title[data-kind="warning"]')).toHaveText("Warning", { timeout: 30_000 })
  await expect(preview).not.toContainText("[!WARNING]")
})

test("README badge links have accessible names", async ({ page }) => {
  requires("codeStorage")
  await page.goto("/smithersai/vibelang/blob/main/README.md")
  const preview = page.locator(".sui-markdown-editor[data-readonly]")
  const npm = preview.locator('a[href="https://www.npmjs.com/package/vibelang"]')
  await expect(npm).toBeVisible({ timeout: 30_000 })
  await expect(npm).toHaveAccessibleName(/\S/)
  await expect(preview.locator('a[href="#license"]')).toHaveAccessibleName(/\S/)
})

test("docs list continuation lines stay inside the list item", async ({ page }) => {
  await page.goto("/smithersai/vibelang/docs/setup/release-notes.md")
  const item = page.locator('[data-slot="markdown"] li').filter({ hasText: "writes only the project's own files" }).first()
  await expect(item).toContainText("dependencies and referenced projects unchanged", { timeout: 30_000 })
})

test("repository code previews highlight once scrolled into view", async ({ page }) => {
  requires("codeStorage")
  await page.goto("/smithersai/smithers/blob/main/packages/smithers/flows/docs/quickstart.md")
  const fence = page.locator(".sui-markdown-editor .milkdown-code-block").first()
  await expect(fence).toBeAttached({ timeout: 30_000 })
  await fence.scrollIntoViewIfNeeded()
  await expect(fence.locator(".sui-markdown-code .sui-rh-tok-keyword").first()).toBeVisible()
})
