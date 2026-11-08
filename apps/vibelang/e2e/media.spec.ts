// Playwright collects browser tests only from JS/TS files.
import { test, expect, type Page, type Locator } from "./coverage"
test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "phone") await page.setViewportSize({ width: 390, height: 844 })
})
const local = `http://127.0.0.1:${process.env.E2E_PORT ?? 4173}`
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
