// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
// The mock sandbox's machine fails once at one step (test/support/faultyMachines.vibe, fault=machine-*): the page shows
// the failure, and the sandbox writer (src/core/sandboxHost.vibe) records it and recovers.
import { expect, test, type Page } from "./coverage"

async function sandboxes(page: Page, fault: string) {
  await page.goto(`/e2e/runtime/index.html?agent=mock&fault=${fault}`)
  await page.getByRole("combobox", { name: "Visit as" }).selectOption("contributor")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  await page.getByRole("dialog").getByRole("textbox").fill("hello")
  await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
  await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
  await page.getByRole("button", { name: "New sandbox" }).click()
}
const status = (page: Page) => page.getByRole("status", { name: "Sandbox" })

test("a machine that fails to start shows the failure, and a retry starts it", async ({ page }) => {
  await sandboxes(page, "machine-start")
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(status(page)).not.toHaveText("Running")
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(status(page)).toHaveText("Running")
})

test("a machine that is gone stops its sandbox", async ({ page }) => {
  await sandboxes(page, "machine-lost")
  await expect(status(page)).toHaveText("Stopped", { timeout: 20_000 })
})

test("a command the machine fails shows the failure and writes no output; the next one runs", async ({ page }) => {
  await sandboxes(page, "machine-command")
  await expect(status(page)).toHaveText("Running")
  const command = page.getByRole("textbox", { name: "Terminal command" })
  await command.fill("pwd")
  await command.press("Enter")
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(page.getByLabel("Terminal output")).not.toContainText("/workspace")
  await command.fill("pwd")
  await command.press("Enter")
  await expect(page.getByLabel("Terminal output")).toContainText("/workspace")
})

test("a stop the machine fails is retried until the sandbox stops", async ({ page }) => {
  await sandboxes(page, "machine-stop")
  await expect(status(page)).toHaveText("Running")
  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(page.getByRole("alert")).toBeVisible()
  await page.getByRole("button", { name: "Retry" }).click()
  await expect(status(page)).toHaveText("Stopped", { timeout: 20_000 })
})

// fault=machine-command-exhausted: the allowance runs out while the machine holds the first command. The meter stops
// the sandbox under it (sandboxHost.vibe `metered`), and the command, back from the stopped machine, is refused and
// leaves the stop's state alone (`command`'s write, `clearsPending`).
test("a command still running when the minutes run out is refused, and the sandbox stops", async ({ page }) => {
  await sandboxes(page, "machine-command-exhausted")
  await expect(status(page)).toHaveText("Running")
  const command = page.getByRole("textbox", { name: "Terminal command" })
  await command.fill("pwd")
  await command.press("Enter")
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole("status", { name: "Sandbox", exact: true })).toHaveText("Stopped", { timeout: 20_000 })
  await expect(page.getByRole("status", { name: "Sandbox minutes" })).toHaveText(/^Out of minutes/)
  await expect(page.getByLabel("Terminal output")).not.toContainText("/workspace")
})

// fault=machine-command-held: the machine holds the first command until the sandbox stops. While a command runs the
// terminal is closed to the next one and Stop stays open (viewDecision.vibe `canSandboxAction`, `sandboxPaneView`).
test("Stop works while a command runs, and the sandbox stops", async ({ page }) => {
  await sandboxes(page, "machine-command-held")
  await expect(status(page)).toHaveText("Running")
  const command = page.getByRole("textbox", { name: "Terminal command" })
  await command.fill("pwd")
  await command.press("Enter")
  await expect(command).toBeDisabled()
  const stop = page.getByRole("button", { name: "Stop", exact: true })
  await expect(stop).toBeEnabled()
  await stop.click()
  await expect(status(page)).toHaveText("Stopped", { timeout: 20_000 })
})
