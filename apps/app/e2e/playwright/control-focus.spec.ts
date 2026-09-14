import { expect, test } from "@playwright/test"
import type { Page } from "@playwright/test"

/*
 * Control focus ("spotlight"): clicking into a card's markdown editor dims the
 * rest of the app modal-style — ONE layer on the body with a hole cut where
 * the surface shows — but the layer is pointer-events:none, so hover and wheel
 * still reach the dimmed content. Clicking out releases exactly like a modal
 * backdrop: the releasing click is swallowed (it does not activate what it
 * landed on) and only the NEXT click acts.
 *
 * Three of the four things asserted here are invisible to a unit test and were
 * shipped broken: the dim composited two and three deep in visible bands, the
 * release affordance was scrolled out of reach while `toBeVisible()` still
 * passed (a bounding box is not a hit test), and its own styling lost every
 * declaration to `.sui-button-ghost` and `.guide-shell button`.
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

/** Drive the tutorial to a world card showing its Document view: the markdown editor surface. */
const openEditorSurface = async (page: Page) => {
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
  return { card, composer, editor }
}

/** Where the release affordance actually answers a pointer, which `toBeVisible()` never asks. */
const releaseIsReachable = async (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const button = document.querySelector("[data-control-focus-release]")
    if (button === null) return false
    const rect = button.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit === button || button.contains(hit)
  })

test("hover and wheel reach dimmed content; the releasing click is swallowed, the next one acts", async ({ page }) => {
  /* A short window so the transcript scroller genuinely overflows. */
  await page.setViewportSize({ width: 1100, height: 520 })
  const { card, composer, editor } = await openEditorSurface(page)
  await editor.click()

  /* Controlled: the card wears the ring; ONE dim layer renders, on the body.
     The marker is namespaced — a bare `data-controlled` is the guide shell's own flag on every bubble. */
  await expect(card).toHaveAttribute("data-control-focus", "human")
  const dim = page.locator("body > .control-focus-dim")
  await expect(dim).toHaveCount(1)
  /* And nowhere else: a layer per stacking ancestor is what composited the dim two and three deep. */
  await expect(page.locator(".control-focus-dim")).toHaveCount(1)
  /* Nothing is lifted to escape a stacking trap any more; the hole does that work. */
  await expect(page.locator("[data-control-focus-host]")).toHaveCount(0)
  /* The hole is cut where the surface shows, so the layer covers the window minus that rect. */
  await expect(dim).toHaveAttribute("aria-hidden", "true")
  expect(await dim.evaluate((element) => getComputedStyle(element).clipPath)).toMatch(/^path\(evenodd,/)

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

  /* And the wheel scrolls the dimmed transcript. The lesson's scroller is the transcript itself:
     the mount and the shell around it are `overflow: hidden` and can never move. */
  const scroller = page.locator(".guide-transcript")
  await expect
    .poll(async () => scroller.evaluate((element) => element.scrollHeight - element.clientHeight), { timeout: 10_000 })
    .toBeGreaterThan(0)
  const before = await scroller.evaluate((element) => element.scrollTop)
  const point = await scroller.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x + 6, y: rect.y + rect.height / 2 }
  })
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, 400)
  await expect.poll(async () => scroller.evaluate((element) => element.scrollTop)).not.toBe(before)

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

/*
 * The invariant, measured in pixels rather than argued from stacking rules:
 * every pixel outside the controlled surface is darkened EXACTLY once. The
 * shipped ladder failed it in three bands at this very viewport — the window's
 * top strip untouched, one layer over the lesson header, two below it.
 *
 * The experiment holds the DOM still and toggles only the layer, so nothing
 * but the dim can move a pixel; two frames of the undimmed state mask off what
 * the page animates on its own (the editor caret, the help bubble).
 */
test("the dim is one layer: every pixel outside the surface is darkened exactly once", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 520 })
  const { editor } = await openEditorSurface(page)
  await editor.click()
  await expect(page.locator(".control-focus-dim")).toHaveCount(1)

  const setDim = async (shown: boolean) => {
    await page.evaluate((shown) => {
      for (const layer of document.querySelectorAll<HTMLElement>(".control-focus-dim")) {
        layer.style.display = shown ? "" : "none"
      }
    }, shown)
    await page.waitForTimeout(250)
  }
  await setDim(false)
  const plainA = (await page.screenshot({ animations: "disabled" })).toString("base64")
  const plainB = (await page.screenshot({ animations: "disabled" })).toString("base64")
  await setDim(true)
  const dimmed = (await page.screenshot({ animations: "disabled" })).toString("base64")

  const alpha = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-focus-dim")) / 100
  )
  expect(alpha).toBeGreaterThan(0)

  const survey = await page.evaluate(
    async ({ plainA, plainB, dimmed, alpha }) => {
      const load = async (b64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext("2d")!
        context.drawImage(bitmap, 0, 0)
        return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data }
      }
      const a = await load(plainA)
      const b = await load(plainB)
      const d = await load(dimmed)
      const luma = (image: typeof a, x: number, y: number) => {
        const i = (image.width * y + x) << 2
        return 0.2126 * image.data[i]! + 0.7152 * image.data[i + 1]! + 0.0722 * image.data[i + 2]!
      }
      /* One layer of rgb(20 17 12) at the token's alpha over luma L. */
      const ink = 0.2126 * 20 + 0.7152 * 17 + 0.0722 * 12
      const once = (l: number) => l * (1 - alpha) + ink * alpha
      const hole = document.querySelector("[data-control-focus]")!.getBoundingClientRect()
      const scale = a.width / window.innerWidth
      const counts = { once: 0, untouched: 0, twice: 0, other: 0 }
      const examples: Array<Record<string, number>> = []
      for (let y = 8; y < a.height - 8; y += 4) {
        for (let x = 8; x < a.width - 8; x += 4) {
          if (x >= (hole.x - 8) * scale && x <= (hole.right + 8) * scale && y >= (hole.y - 8) * scale && y <= (hole.bottom + 8) * scale) continue
          const base = luma(a, x, y)
          /* Only pixels the page itself holds still, and only where the 1.5px blur cannot move ink in. */
          let steady = Math.abs(luma(b, x, y) - base) <= 1
          for (let dy = -3; steady && dy <= 3; dy++) {
            for (let dx = -3; steady && dx <= 3; dx++) steady = Math.abs(luma(a, x + dx, y + dy) - base) <= 1
          }
          if (!steady) continue
          const lit = luma(d, x, y)
          if (Math.abs(lit - once(base)) <= 2.5) counts.once++
          else if (Math.abs(lit - base) <= 2.5) {
            counts.untouched++
            if (examples.length < 5) examples.push({ x, y, base: Math.round(base), lit: Math.round(lit) })
          } else if (Math.abs(lit - once(once(base))) <= 2.5) {
            counts.twice++
            if (examples.length < 5) examples.push({ x, y, base: Math.round(base), lit: Math.round(lit) })
          } else {
            counts.other++
            if (examples.length < 5) examples.push({ x, y, base: Math.round(base), lit: Math.round(lit) })
          }
        }
      }
      return { counts, examples }
    },
    { plainA, plainB, dimmed, alpha }
  )

  const { once, untouched, twice, other } = survey.counts
  /* A survey this small would prove nothing; the window holds thousands of steady pixels. */
  expect(once + untouched + twice + other).toBeGreaterThan(2000)
  expect({ untouched, twice, other, examples: survey.examples }).toEqual({ untouched: 0, twice: 0, other: 0, examples: [] })
})

/*
 * The BOX, not the element that took focus. Will's words are "we show the box
 * it's in expand just a tad": the hole, the ring and the affordance all dress
 * the card, so its title row and its footer stay bright with the rest of it.
 * The markdown editor is what focus lands on and what names the surface, and
 * it must never be what the geometry is measured from — this viewport is tall
 * enough that the whole card is on screen, so the two are plainly different
 * rectangles and a regression cannot hide behind a scroller's clipping.
 */
test("the hole is the card's box, not the inner element that took focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  const { card, editor } = await openEditorSurface(page)
  await editor.click()
  await expect(page.locator(".control-focus-dim")).toHaveCount(1)

  /*
   * The card element comes from the locator the test clicked into: during the
   * tutorial the app is mounted twice (the lesson's copy and the live shell
   * behind it, at `opacity: 0`), so a fresh `querySelector` can pick the copy
   * the user never sees.
   */
  const geometry = await card.evaluate((cardElement) => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect()
      return [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)]
    }
    const dim = document.querySelector<HTMLElement>(".control-focus-dim")!
    /* Whatever wears the ring, named rather than assumed, so a regression reads as itself. */
    const marked = document.querySelector("[data-control-focus]")!
    const card = cardElement
    /* The layer's path is the viewport, then the hole; the hole is the second subpath. */
    const hole = (getComputedStyle(dim).clipPath.split("Z")[1]!.match(/-?[\d.]+/g) ?? []).slice(0, 4).map(Number)
    return {
      hole,
      card: rect(card),
      header: rect(card.querySelector(".smithers-card-header")!),
      editor: rect(card.querySelector("[data-slot='markdown-editor']")!),
      outset: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-focus-outset")),
      marked: `${marked.tagName.toLowerCase()}.${(marked.className || "").toString().split(" ")[0] ?? ""}`,
      markedIsTheCard: marked === card,
      markers: document.querySelectorAll("[data-control-focus]").length,
      editorIsMarked: card.querySelector("[data-slot='markdown-editor']")!.hasAttribute("data-control-focus")
    }
  })

  /* One box wears the ring, and it is the card. */
  expect(geometry.markers).toBe(1)
  expect({ marked: geometry.marked, isTheCard: geometry.markedIsTheCard }).toEqual({ marked: "section.smithers-card", isTheCard: true })
  expect(geometry.editorIsMarked).toBe(false)
  /* The hole IS the card, grown by the ring's own outset so the ring is not dimmed either. */
  const { card: box, outset } = geometry
  expect(geometry.hole).toEqual([box[0]! - outset, box[1]! - outset, box[2]! + outset, box[3]! + outset])
  /* Which is strictly bigger than the element focus landed on, and covers the card's title row. */
  expect(geometry.editor[1]!).toBeGreaterThan(geometry.hole[1]!)
  expect(geometry.header[1]!).toBeGreaterThanOrEqual(geometry.hole[1]!)
  expect(geometry.header[3]!).toBeLessThanOrEqual(geometry.hole[3]!)
  /* The whole card is on screen at this viewport, so nothing above is a scroller's doing. */
  expect(box[3]! - box[1]!).toBeGreaterThan(geometry.editor[3]! - geometry.editor[1]!)

  await expect(card).toHaveAttribute("data-control-focus", "human")
})

/*
 * The affordance is the ONLY way out of a focused cross-origin frame — that
 * surface swallows every key, Escape included — so "reachable" has to mean a
 * pointer lands on it, at every viewport. `toBeVisible()` checks a bounding
 * box and passed while the card's own scroller had scrolled the button away.
 */
test("the release affordance is reachable at every viewport, and reads as a control", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 520 })
  const { card, editor } = await openEditorSurface(page)
  await editor.click()
  const release = card.locator("[data-control-focus-release]")
  await expect(release).toHaveText("Release control")

  for (const size of [
    { width: 1100, height: 520 },
    { width: 980, height: 700 },
    { width: 1440, height: 900 },
    { width: 1280, height: 460 },
    { width: 760, height: 600 }
  ]) {
    await page.setViewportSize(size)
    await expect.poll(async () => releaseIsReachable(page), { timeout: 5_000 }).toBe(true)
  }

  /* And it looks like a control: its own recipe, not the ghost button's transparent one. */
  const style = await release.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      fontSize: computed.fontSize,
      background: computed.backgroundColor,
      borderColor: computed.borderTopColor,
      borderWidth: computed.borderTopWidth
    }
  })
  expect(style.fontSize).toBe("11px")
  expect(style.borderWidth).toBe("1px")
  for (const colour of [style.background, style.borderColor]) {
    expect(colour).not.toBe("rgba(0, 0, 0, 0)")
    expect(colour).not.toBe("transparent")
  }
  /* An opaque fill, so the label is legible over a terminal or a frame. */
  expect(style.background).toMatch(/^rgb\(/)

  /* It releases, and takes the dim with it. */
  await release.click()
  await expect(page.locator(".control-focus-dim")).toHaveCount(0)
  await expect(card).not.toHaveAttribute("data-control-focus", /./)
})

test('guidance glows separately from keyboard focus and the transcript shows its focus', async ({ page }) => {
  await page.goto('/smithersai/smithers/?tutorial')
  const guided = page.getByRole('button', { name: 'Show issues', exact: true })
  const skip = page.getByRole('button', { name: 'Skip tutorial', exact: true })
  await skip.focus()
  await expect(skip).toBeFocused()
  expect(await skip.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid')
  expect(await guided.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('solid')
  await page.keyboard.press('Tab')
  const transcript = page.getByRole('log', { name: 'Onboarding chat history' })
  await expect(transcript).toBeFocused()
  expect(await transcript.evaluate(node => getComputedStyle(node).outlineWidth)).toBe('2px')
})

test('Chat dims and blocks the top header too, with a modal focus boundary and valid palette references', async ({ page }) => {
  await page.goto('/smithersai/smithers/?tutorial')
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Chat', exact: true })
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  expect(await page.locator('.guide-composer-dock').evaluate(node => node.matches(':modal'))).toBe(true)
  expect(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, 20)?.classList.contains('guide-composer-dock'))).toBe(true)
  await expect(page.locator('.guide-content')).toHaveAttribute('inert', '')
  const input = page.getByRole('combobox', { name: 'Chat message' })
  await expect(input).toBeFocused()
  await expect(input).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowDown')
  expect(await input.evaluate(node => {
    const list = document.getElementById(node.getAttribute('aria-controls')!)
    const selected = document.getElementById(node.getAttribute('aria-activedescendant')!)
    return !!list?.contains(selected) && selected?.getAttribute('aria-selected') === 'true'
  })).toBe(true)
  await page.locator('.guide-wordmark').evaluate((node: HTMLElement) => node.focus())
  await expect(input).toBeFocused()
  await page.keyboard.press('Escape')
  // The active palette closes first; the modal boundary remains until Chat closes.
  await expect(input).toHaveAttribute('aria-expanded', 'false')
  await expect(dialog).toBeVisible()
  await expect(page.locator('.guide-content')).toHaveAttribute('inert', '')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.locator('.guide-content')).not.toHaveAttribute('inert', '')
})
