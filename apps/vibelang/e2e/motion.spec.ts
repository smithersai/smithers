import { expect, test } from "@playwright/test"

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
  await page.getByRole("textbox", { name: "Message" }).fill("install")
  const thinking = page.waitForFunction(() => {
    const dots = document.querySelector(".vl-dots")
    return dots && getComputedStyle(dots).animationName === "none"
  })
  await page.getByRole("textbox", { name: "Message" }).press("Enter")
  await thinking
})
