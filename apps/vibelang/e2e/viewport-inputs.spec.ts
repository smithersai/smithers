// Stays .ts: Playwright collects test files by JS/TS extension only.
// Inputs that do not pause following (src/web/viewport.vibe over the proved screenDecision steps): a wheel down at
// the bottom, a finger moving up, and a swipe or a wheel up before the chat opens.
// touch.spec.ts and scroll.spec.ts cover the inputs that do pause.
import { expect, test, type Page } from "./coverage"

test.use({ hasTouch: true })

/** `count` finished answers, following at the bottom. */
async function chat(page: Page, count: number) {
  await page.getByRole("button", { name: "Ask the agent" }).click()
  const input = page.getByRole("textbox", { name: "Message" })
  const answers = page.locator(".sui-chat-message[data-role='assistant']")
  for (let index = 0; index < count; index++) {
    await input.fill("What is a service?")
    await input.press("Enter")
    await expect(answers).toHaveCount(index + 1)
    await expect(answers.last()).toHaveAttribute("data-done", "true")
  }
  await page.mouse.move(100, 200)
  return { answers, latest: page.getByRole("button", { name: "Latest" }) }
}

const scrollable = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight)

async function swipe(page: Page, ys: ReadonlyArray<number>) {
  const session = await page.context().newCDPSession(page)
  try {
    const [first, ...rest] = ys
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 100, y: first!, id: 1 }] })
    for (const y of rest) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 100, y, id: 1 }] })
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  } finally {
    await session.detach()
  }
}

test("a wheel down at the bottom keeps following, and a wheel up then pauses it", async ({ page }) => {
  await page.goto("/?agent=mock")
  const { latest } = await chat(page, 3)
  expect(await scrollable(page)).toBe(true)
  await page.mouse.wheel(0, 300)
  await expect(latest).toBeHidden()
  await page.mouse.wheel(0, -300)
  await expect(latest).toBeVisible()
})

test("a finger moving up at the bottom keeps following", async ({ page }) => {
  await page.goto("/?agent=mock")
  const { latest } = await chat(page, 3)
  await swipe(page, [450, 400, 300, 200])
  await expect(latest).toBeHidden()
})

test("a swipe or a wheel up before the chat opens does not stop the first answers following", async ({ page }) => {
  await page.goto("/?agent=mock")
  await swipe(page, [200, 300, 450])
  await page.mouse.move(100, 200)
  await page.mouse.wheel(0, -300)
  const { latest, answers } = await chat(page, 3)
  await expect(latest).toBeHidden()
  await expect(answers.last().locator("p").last()).toBeInViewport()
})
