// Stays .ts: Playwright collects test files by JS/TS extension only (upstream-bugs/playwright-vibe-specs).
import { expect, test } from "./coverage"

test("the splash video has a pause control", async ({ page }) => {
  await page.goto("/")
  const video = page.locator(".vl-media video")
  await expect(video).toHaveJSProperty("controls", true)
  await video.evaluate(async (element: HTMLVideoElement) => { await element.play(); element.pause() })
  await expect(video).toHaveJSProperty("paused", true)
})

test("reduced motion starts with a still poster and disables chat animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  const video = page.locator(".vl-media video")
  await expect(video).toHaveJSProperty("autoplay", false)
  await expect(video).toHaveJSProperty("paused", true)
  await page.getByRole("button", { name: "Ask the agent" }).click()
  await expect(page.locator(".vl-palette-scrim")).toHaveCSS("animation-name", "none")
  // Hold the real first delta in a faulty Effect transport, so this observable state lasts until released.
  const port = process.env.E2E_PORT ?? process.env.E2E_4510 ?? process.env.E2E_4508 ?? process.env.E2E_4505 ?? process.env.E2E_4501 ?? process.env.E2E_4516 ?? process.env.E2E_4511 ?? process.env.E2E_4502 ?? 4173
  await page.goto(`http://127.0.0.1:${port}/e2e/runtime/index.html?fault=thinking`)
  await page.getByRole("button", { name: "Ask the agent" }).click()
  await page.getByRole("textbox", { name: "Message" }).fill("install")
  await page.getByRole("textbox", { name: "Message" }).press("Enter")
  await expect(page.locator(".vl-dots")).toHaveCSS("animation-name", "none")
  await page.evaluate(() => window.recovery.release())
  const answer = page.locator(".sui-chat-message[data-role='assistant']")
  await expect(answer).toHaveAttribute("data-done", "true")
  await expect(answer).toContainText("npm create vibelang@latest my-app")
})
