import { expect, test } from "@playwright/test"

test("a late boot recovers after the startup watchdog without losing React's mount point", async ({ page }) => {
  await page.clock.install()
  let release!: () => void
  let reached!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const requested = new Promise<void>((resolve) => { reached = resolve })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/ControllerBoot.client*.js", async (route) => {
    reached()
    await held
    await route.continue()
  })
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await requested
    await expect(page.locator(".session-shell > .guide-wordmark")).toHaveCount(1)
    const entrance = await page.locator(".session-shell > .guide-wordmark").elementHandle()
    await expect(page.locator("body")).not.toContainText("Smithers is starting your session.")
    /*
     * Settle the entrance before measuring its corner: the wordmark's anchor
     * shifts ~5px when IBM Plex Mono swaps in over the fallback mono, and the
     * arrive animation is compositor time, never the fake clock. The pin's
     * subject is the app arrival moving the mark, not the font loading.
     */
    await page.evaluate(() =>
      Promise.all([document.fonts.ready, ...document.getAnimations().map((animation) => animation.finished)])
    )
    await page.clock.fastForward(2_000)
    const corner = await entrance!.boundingBox()
    expect(corner!.x).toBeGreaterThan(900)
    await expect(page.locator("body")).not.toContainText("This build isn't connected")
    // The bundle is deliberately still in flight after the watchdog's budget.
    await page.clock.fastForward(90_000)
    await expect(page.locator("[data-startup-failure]")).toContainText("Smithers failed to start")
    await expect(page.locator("#root .session-shell")).toHaveCount(1)
    release()
    await page.clock.resume()
    await expect(page.locator(".guide-shell")).toBeVisible({ timeout: 20_000 })
    expect(await entrance!.evaluate(node => node.isConnected)).toBe(true)
    await expect(page.locator(".guide-wordmark")).toHaveCount(1)
    expect((await entrance!.boundingBox())!.x).toBeCloseTo(corner!.x, 0)
    await expect(page.locator("[data-startup-failure]")).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    release()
  }
})
