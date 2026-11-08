// Playwright collects browser tests only from JS/TS files.
import { test, expect, type Page, type Locator } from "@playwright/test"
test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "phone") await page.setViewportSize({ width: 390, height: 844 })
})
const local = `http://127.0.0.1:${process.env.E2E_4516 ?? process.env.E2E_PORT ?? 4173}`
const stops = [
  ["/", "card-01-contract.png"],
  ["/getting-started/002-why-effect", "magic-move.mp4"],
  ["/vibelang-features/115-cheat-sheet", "token-bars.png"],
  ["/setup", "card-07-install.png"],
  ["/vips", "agent-loop.mp4"],
] as const
async function inside(page: Page, el: Locator) {
  const box = (await el.boundingBox())!
  expect(box).not.toBeNull()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.width).toBeGreaterThan(0)
  expect(box.height).toBeGreaterThan(0)
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height)
}
async function loaded(image: Locator) {
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
}
test("the header fits at 390px and Vibe has a painted gradient", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/?agent=mock")
  await expect(page.getByText("Mock", { exact: true })).toBeVisible()
  for (const el of await page.locator(".vl-top button, .vl-top a, .vl-top .vl-pill").all()) await inside(page, el)
  const home = (await page.locator(".vl-home").boundingBox())!
  const nav = (await page.locator(".vl-nav").boundingBox())!
  expect(home.x + home.width).toBeLessThanOrEqual(nav.x)
  expect(await page.locator(".vl-gradient").evaluate(el => getComputedStyle(el).backgroundImage)).toContain("linear-gradient")
})
test("each tour stop loads its assigned media beside the docs and words", async ({ page }, info) => {
  test.setTimeout(150_000)
  await page.goto("/?agent=mock")
  await loaded(page.locator(".vl-logo img"))
  const hero = page.locator(".vl-media video")
  await expect.poll(() => hero.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2)
  await expect(hero).toHaveJSProperty("muted", true)
  await expect(hero).toHaveJSProperty("loop", true)
  // Observe native loading at insertion, before the browser has decoded a frame.
  await page.evaluate(() => {
    const pending: string[] = []
    ;(window as any).mediaLoading = pending
    new MutationObserver(() => document.querySelectorAll<HTMLVideoElement>(".vl-stop-media video").forEach(video => {
      if (video.readyState < 2 && video.poster) pending.push(new URL(video.poster).pathname)
    })).observe(document.body, { subtree: true, childList: true })
  })
  await page.getByRole("button", { name: "Learn more" }).click()
  for (const [index, [path, file]] of stops.entries()) {
    await expect(page.getByTitle("VibeLang docs")).toHaveAttribute("src", "https://vibelang.sh" + path, { timeout: 35_000 })
    const figure = page.locator(".vl-stop-media")
    const asset = figure.locator(file.endsWith("mp4") ? "video" : "img")
    await expect(asset).toHaveAttribute("src", "/media/" + file)
    await expect(asset).toBeVisible()
    if (file.endsWith("mp4")) {
      await expect(asset).toHaveAttribute("poster", "/media/" + file.replace(".mp4", "-poster.jpg"))
      const poster = "/media/" + file.replace(".mp4", "-poster.jpg")
      expect(await page.evaluate(async src => { const image = new Image(); image.src = src; await image.decode(); return image.naturalWidth }, poster)).toBeGreaterThan(0)
      expect(await page.evaluate(() => (window as any).mediaLoading)).toContain(poster)
      await expect(asset).toHaveJSProperty("muted", true)
      await expect(asset).toHaveJSProperty("playsInline", true)
      await expect(asset).toHaveJSProperty("controls", false)
      await expect(asset).toHaveJSProperty("loop", file === "agent-loop.mp4")
      await expect.poll(() => asset.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThanOrEqual(2)
      await expect.poll(() => asset.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0)
    } else await loaded(asset)
    await inside(page, figure)
    await inside(page, page.getByTitle("VibeLang docs"))
    await inside(page, page.getByRole("region", { name: "Current stop" }))
    await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"))
    await page.screenshot({ path: info.outputPath(`tour-${index + 1}.png`), scale: "css" })
  }
})
test("reduced motion shows loaded posters instead of tour videos", async ({ page }) => {
  test.setTimeout(150_000)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/?agent=mock")
  await expect(page.locator(".vl-media video")).toHaveJSProperty("paused", true)
  await page.getByRole("button", { name: "Learn more" }).click()
  for (const [path, file] of stops.filter(([, file]) => file.endsWith(".mp4"))) {
    await expect(page.getByTitle("VibeLang docs")).toHaveAttribute("src", "https://vibelang.sh" + path, { timeout: 90_000 })
    await expect(page.locator(".vl-stop-media video")).toHaveCount(0)
    const image = page.locator(".vl-stop-media img")
    await expect(image).toHaveAttribute("src", "/media/" + file.replace(".mp4", "-poster.jpg"))
    await loaded(image)
    await inside(page, image)
  }
})
test("a real video decode failure removes the figure and keeps the tour usable", async ({ page }) => {
  await page.goto(local + "/e2e/runtime/index.html?fault=media-video")
  await page.getByRole("button", { name: "Learn more" }).click()
  await expect(page.locator(".vl-stop-media img")).toBeVisible()
  await expect(page.getByTitle("VibeLang docs")).toHaveAttribute("src", "https://vibelang.sh/getting-started/002-why-effect", { timeout: 35_000 })
  await expect(page.locator(".vl-stop-media")).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Current stop" })).toContainText("Effect gives")
  await inside(page, page.getByTitle("VibeLang docs"))
  await page.keyboard.press("Escape")
  await expect(page.locator(".vl-glow")).toHaveCount(0)
  await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
})
test("the empty chat loads the compiler card", async ({ page }, info) => {
  await page.goto(local + "/e2e/runtime/index.html?fault=media-empty")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  const image = page.locator(".vl-empty-media img")
  await expect(image).toHaveAttribute("src", "/media/card-06-compiler.png")
  await loaded(image)
  await inside(page, image)
  await page.screenshot({ path: info.outputPath("empty-chat.png"), scale: "css" })
})

test("a failed empty-state image leaves the composer usable", async ({ page }) => {
  await page.goto(local + "/e2e/runtime/index.html?fault=media-image")
  await expect(page.locator(".vl-app")).toHaveAttribute("data-surface", "chat")
  await expect(page.locator(".vl-empty-media")).toHaveCount(0)
  const input = page.getByRole("textbox", { name: "Message" })
  await input.fill("install")
  await input.press("Enter")
  await expect(page.locator(".sui-chat-message[data-role='assistant']")).toHaveAttribute("data-done", "true")
})
