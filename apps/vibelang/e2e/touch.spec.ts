// Stays .ts: Playwright collects test files by JS/TS extension only.
import { expect, test } from "@playwright/test"

test.use({ hasTouch: true })

test("touch scrolling pauses a streamed answer, and Latest resumes following after end and cancellation", async ({ page }, info) => {
  await page.goto("/?agent=mock")
  await page.getByRole("button", { name: "Ask the agent" }).click()
  const input = page.getByRole("textbox", { name: "Message" })
  const answers = page.locator(".sui-chat-message[data-role='assistant']")
  for (let index = 0; index < 3; index++) {
    await input.fill("What is a service?")
    await input.press("Enter")
    await expect(answers).toHaveCount(index + 1)
    await expect(answers.last()).toHaveAttribute("data-done", "true")
  }
  const session = await page.context().newCDPSession(page)
  await page.evaluate(() => {
    const observations: unknown[] = []
    Reflect.set(window, "touchObservations", observations)
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "click", "scroll", "scrollend"]) {
      document.addEventListener(type, (event) => {
        const target = event.target instanceof Element ? event.target.closest("button")?.getAttribute("aria-label") : null
        observations.push({ type, target, y: window.scrollY, following: document.querySelector("[data-following]")?.getAttribute("data-following"), at: performance.now() })
      }, { capture: true })
    }
  })
  try {
    for (const ending of ["touchEnd", "touchCancel"] as const) {
      await input.fill("What is a service?")
      await input.press("Enter")
      await expect(answers.last()).toHaveAttribute("data-done", "false")
      const before = await page.evaluate(() => window.scrollY)
      expect(before).toBeGreaterThan(0)
      const observationStart = await page.evaluate(() => Reflect.get(window, "touchObservations").length as number)
      // A fast native swipe may keep scrolling after touchEnd; wait for Chromium's scrollend before tapping.
      await page.evaluate(() => {
        document.documentElement.dataset.gestureSettled = "false"
        const observation = new AbortController()
        let ended = false
        for (const type of ["touchend", "touchcancel"]) document.addEventListener(type, () => { ended = true }, { signal: observation.signal })
        document.addEventListener("scrollend", () => {
          // Starting a drag can end an earlier follow scroll; only this gesture's end counts.
          if (!ended) return
          document.documentElement.dataset.gestureSettled = "true"
          observation.abort()
        }, { signal: observation.signal })
      })
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 100, y: 200, id: 1 }] })
      for (const y of [250, 300, 350, 400, 450]) {
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 100, y, id: 1 }] })
      }
      await session.send("Input.dispatchTouchEvent", { type: ending, touchPoints: [] })
      const latest = page.getByRole("button", { name: "Latest" })
      await expect(latest).toBeVisible()
      await expect(answers.last()).toHaveAttribute("data-done", "true")
      await expect(latest).toBeVisible()
      // The answer may grow while CDP is delivering the gesture. Measure the actual first move, when pausing
      // begins, rather than the earlier scroll position before the finger reached the page.
      const firstMoveY = await page.evaluate((start) =>
        (Reflect.get(window, "touchObservations") as { type: string; y: number }[]).slice(start).find(event => event.type === "touchmove")?.y, observationStart)
      expect(firstMoveY).toBeDefined()
      expect(await page.evaluate(() => window.scrollY)).toBeLessThan(firstMoveY!)
      await expect(page.locator("html")).toHaveAttribute("data-gesture-settled", "true")
      await latest.tap()
      await expect(latest).toBeHidden()
      await expect(answers.last().locator("p").last()).toBeInViewport({ ratio: 1 })
    }
  } finally {
    await info.attach("native-touch-order", { body: JSON.stringify(await page.evaluate(() => Reflect.get(window, "touchObservations"))), contentType: "application/json" })
    await session.detach()
  }
})
