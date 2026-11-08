// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "@playwright/test"

declare global {
  interface Window {
    startup: {
      snapshot: () => { calls: number; settled: boolean }
      release: () => Promise<boolean>
    }
  }
}

test.use({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 4173}` })

for (const input of ["Command K", "Tab"] as const) {
  test(`${input} works while the startup health answer is held open`, async ({ page }) => {
    await page.goto("/e2e/runtime/index.html?fault=health")
    await expect.poll(() => page.evaluate(() => window.startup?.snapshot().calls)).toBe(1)
    await expect(page.getByRole("heading", { name: "VibeLang", exact: true })).toBeVisible({ timeout: 500 })
    await expect(page.locator(".vl-pill")).toHaveCount(0)
    if (input === "Command K") {
      await page.keyboard.press("ControlOrMeta+k")
    } else {
      // Home, Docs, GitHub, Learn more, then Ask the agent.
      for (let i = 0; i < 5; i++) await page.keyboard.press("Tab")
      await expect(page.getByRole("button", { name: "Ask the agent" })).toBeFocused()
      await page.keyboard.press("Enter")
    }
    const prompt = page.getByRole("textbox", { name: "Message" })
    await expect(prompt).toBeFocused()
    await prompt.fill("What is a service?")
    await prompt.press("Enter")
    await expect(page.locator("[data-pending='true']")).toContainText("What is a service?")
    expect(await page.evaluate(() => window.startup.snapshot())).toEqual({ calls: 1, settled: false })
    await page.evaluate(() => window.startup.release())
    await expect(page.locator(".vl-pill")).toHaveText("Mock")
    await expect(page.locator("[data-role='assistant'][data-done='true']")).toHaveCount(1)
    await expect(page.locator("[data-pending='true']")).toHaveCount(0)
    expect(await page.evaluate(() => window.startup.snapshot())).toEqual({ calls: 1, settled: true })
  })
}

for (const preference of ["query", "storage"] as const) {
  test(`${preference} forces the working mock without probing health`, async ({ page }) => {
    if (preference === "storage") {
      await page.addInitScript(() => localStorage.setItem("vibelang.agent", "mock"))
    }
    await page.goto(`/e2e/runtime/index.html?fault=health${preference === "query" ? "&agent=mock" : ""}`)
    await page.keyboard.press("ControlOrMeta+k")
    const prompt = page.getByRole("textbox", { name: "Message" })
    await expect(prompt).toBeFocused()
    await prompt.fill("install")
    await prompt.press("Enter")
    await expect(page.locator(".vl-pill")).toHaveText("Mock")
    await expect(page.locator("[data-role='assistant'][data-done='true']")).toHaveCount(1)
    expect(await page.evaluate(() => window.startup.snapshot())).toEqual({ calls: 0, settled: false })
  })
}
