import { expect, test } from "./fixtures"
import { requires, signedOut } from "./target"

test.use(signedOut)

test("flow reference: current configuration does not promise a wiki", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/flows/")
  await expect(page.getByRole("heading", { level: 1, name: "Flows reference" })).toBeVisible()
  await expect(page.locator("main")).not.toContainText("default wiki pages")
})

test("flow reference: published instructions use personal-flow commands and controls", async ({ page }) => {
  requires("docsSite")
  await page.goto("/docs/flows/")
  const content = page.locator(".sl-markdown-content")
  await expect(content.getByRole("link", { name: "Flows", exact: true })).toHaveAttribute("href", /\/app\/flows$/)
  await expect(content).toContainText("/flow.new greet")
  await expect(content).toContainText("/flow.run greet")
  await expect(content).toContainText("Needs a sandbox")
  const instructions = (await content.locator("code").allTextContents()).map((text) => text.trim())
  for (const command of ["/help", "/flows", "/flow todo", "/flow.edit", "/flow.source"]) {
    expect(instructions.some((text) => text === command || text.startsWith(`${command} `)), `unsupported command ${command}`).toBe(false)
  }
})
