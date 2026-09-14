import { expect, test } from "@playwright/test"

/*
 * Control focus ("spotlight"): clicking into a card's markdown editor dims
 * the rest of the app modal-style — one dim layer inside .app-shell plus the
 * scoped dim the trapped transcript scroller carries — but both layers are
 * pointer-events:none, so hover and wheel still reach the dimmed content.
 * Clicking out releases exactly like a modal backdrop: the releasing click
 * is swallowed (it does not activate what it landed on) and only the NEXT
 * click acts.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

test("hover and wheel reach dimmed content; the releasing click is swallowed, the next one acts", async ({ page }) => {
  /* A short window so the transcript scroller genuinely overflows. */
  await page.setViewportSize({ width: 1100, height: 520 })
  await page.goto("/")
  /* The guide shell owns first paint; the composer hides until summoned (2026-09-08 brief). */
  await expect(page.locator(".guide-shell")).toBeVisible()
  await page.keyboard.press("Control+k")
  const composer = page.getByTestId("composer-input")
  await expect(composer).toBeVisible()

  /* A note embedded as a world card; its Document view is the markdown editor surface. */
  await composer.fill("/wiki.new-note")
  await composer.press("Enter")
  const card = page.locator(".smithers-card[data-kind='world']").last()
  await expect(card).toBeVisible()
  /* The Document view is the markdown editor surface; the flow door, not a click the open dock could occlude. */
  const cardId = (await card.getAttribute("data-testid"))!.replace(/^card-/, "")
  await composer.fill(`/wiki.card.view ${cardId} document`)
  await composer.press("Enter")
  const editor = card.locator("[data-slot='markdown-editor'] .ProseMirror")
  await expect(editor).toBeVisible({ timeout: 15_000 })
  /* The composer dock is a fixed layer over the transcript while open; Escape closes it (2026-09-08 brief). */
  await page.keyboard.press("Escape")
  await expect(composer).toBeHidden()
  await editor.click()

  /* Controlled: the card wears the ring; the shell dim and the trapping scroller's scoped dim render.
     The marker is namespaced — a bare `data-controlled` is the guide shell's own flag on every bubble. */
  await expect(card).toHaveAttribute("data-control-focus", "human")
  const dim = page.locator(".app-shell > .control-focus-dim")
  await expect(dim).toHaveCount(1)
  /* The lesson mount's scroller (contain:layout) traps the card: it lifts and carries the scoped dim. */
  const host = page.locator("[data-control-focus-host]")
  await expect(host).toHaveCount(1)
  await expect(host.locator(".control-focus-dim--scoped")).toHaveCount(1)

  /* The dim never intercepts: what sits under the pointer is the content, not the layer. */
  const chatButton = page.getByRole("button", { name: "Chat" }).first()
  const underPoint = await chatButton.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit === element || element.contains(hit)
  })
  expect(underPoint).toBe(true)

  /* Hover styles still apply over dimmed content. */
  await chatButton.hover()
  expect(await chatButton.evaluate((element) => element.matches(":hover"))).toBe(true)

  /* And the wheel scrolls the dimmed transcript (pointer over dimmed content, away from the raised card). */
  await expect
    .poll(async () => host.evaluate((element) => element.scrollHeight - element.clientHeight), { timeout: 10_000 })
    .toBeGreaterThan(0)
  const before = await host.evaluate((element) => element.scrollTop)
  const point = await host.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x + 40, y: rect.y + 24 }
  })
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, 400)
  await expect.poll(async () => host.evaluate((element) => element.scrollTop)).not.toBe(before)

  /* The ring carries its own way out for a surface no chord can reach (a focused cross-origin frame). */
  const release = card.locator("[data-control-focus-release]")
  await expect(release).toBeVisible()
  await expect(release).toHaveText("Release control")

  /* The releasing click only unfocuses: the Chat button it landed on did not summon the composer. */
  await chatButton.click()
  await expect(dim).toHaveCount(0)
  await expect(card).not.toHaveAttribute("data-control-focus", /./)
  await expect(composer).toBeHidden()
  /* Focus landed on the surface's card section, never on body. */
  const activeClass = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? "")
  expect(activeClass).toContain("smithers-card")

  /* The NEXT click is a normal click: the composer opens. */
  await chatButton.click()
  await expect(composer).toBeVisible()
})
