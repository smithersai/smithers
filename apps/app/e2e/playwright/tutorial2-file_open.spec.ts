import { expect, test, type Page } from "@playwright/test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const slash = async (page: Page, command: string) => {
  if (!(await page.getByTestId("composer-input").isVisible())) await page.keyboard.press("Control+k")
  await page.getByTestId("composer-input").fill(command)
  await page.keyboard.press("Enter")
}
const stage = (page: Page, value: number) => expect(page.locator(".guide-shell")).toHaveAttribute("data-stage", String(value))

// Prior lanes are setup only. File completion itself must come from the real host read.
const enterFileLesson = async (page: Page, root: string) => {
  await page.goto("/")
  await stage(page, 1)
  await slash(page, `/repo.open ${root}`)
  for (const [index, signal] of ["identity.signed-in", "repository.ready", "issues.opened"].entries()) {
    await stage(page, index + 1)
    await slash(page, `/onboarding.act signal ${signal}`)
    await stage(page, index + 2)
  }
}

test("file chooser uses the selected repo; keyboard submission renders real code and completes lesson 5", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "tutorial2-file_open-"))
  mkdirSync(join(root, "src"))
  const content = "export const tutorialFileAnswer = 42\n"
  writeFileSync(join(root, "src", "answer.ts"), content)
  spawnSync("git", ["init", "-q", root])
  try {
    await enterFileLesson(page, root)
    await slash(page, "/files.list /")
    await stage(page, 4)
    await slash(page, "/files.read missing.ts")
    await stage(page, 4)
    await slash(page, "/files.read src")
    await stage(page, 4)
    await slash(page, "/files.read answer.ts unrelated/repo")
    await stage(page, 4)
    await expect(page.locator('[data-message-step="4"] .guide-step-done')).toHaveCount(0)
    await slash(page, "/files.read")
    const form = page.locator('[data-tutorial-files] [data-flow-name="files.read"]')
    await expect(form.locator("[data-field]")).toHaveCount(1)
    const path = form.getByRole("combobox", { name: "Path", exact: true })
    await expect(path.locator('option[value="src/answer.ts"]')).toHaveCount(1)
    await expect(path.locator('option[value="src"]')).toHaveCount(0)
    // Reach and operate the native select with Tab/arrow keys, then Submit with Enter.
    for (let count = 0; count < 80 && !(await path.evaluate(node => node === document.activeElement)); count++) await page.keyboard.press("Tab")
    await expect(path).toBeFocused()
    await page.keyboard.press("s")
    await page.keyboard.press("Enter")
    await expect(path).toHaveValue("src/answer.ts")
    const submit = form.getByTestId("flow-form-submit")
    for (let count = 0; count < 10 && !(await submit.evaluate(node => node === document.activeElement)); count++) await page.keyboard.press("Tab")
    await expect(submit).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.locator('[data-message-step="4"] .guide-step-done').first()).toBeVisible()
    await expect(page.locator("[data-tutorial-files] .code-surface")).toContainText(content.trim())
    await stage(page, 5)
    await page.reload()
    await stage(page, 5)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
