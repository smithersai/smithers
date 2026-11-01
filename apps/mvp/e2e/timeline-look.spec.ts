import type { Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { expect, test } from "./devices"
import { requires, scriptedAgent } from "./target"
import { shapeRows, type Row } from "./shape"
import { exchangeUnits, phaseUnits, planOf } from "../src/features/timeline/marks"
import { railMarkers } from "../src/features/timeline/view"

// The rail against the approved mock (docs/design/timeline): screenshots of a real conversation at the two desktop
// sizes, in both themes, at three lengths, beside the mock's own (test-results/timeline-look/).
requires("scriptedAgent", "member")

const LENGTHS = { short: 3, medium: 20, long: 64 } as const
const SIZES = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }] as const

// Variable semantic spans take the long fixture into three columns within the default summary allowance: the scripted summary model starts a span where the topic changes.
const STRETCHES = [["issue 450", 3], ["checkout tests", 1], ["review 104", 2], ["login redirect", 4], ["coupon rules", 2], ["release notes", 3], ["search index", 1], ["payment form", 2]] as const
const topicOf = (n: number) => {
  let at = n % STRETCHES.reduce((sum, [, size]) => sum + size, 0)
  for (const [topic, size] of STRETCHES) { if (at < size) return topic; at -= size }
  return STRETCHES[0][0]
}
const question = (n: number) => `Topic: ${topicOf(n)}. Check step ${n + 1} of the ${topicOf(n)}`
const answer = (n: number) => `Topic: ${topicOf(n)}. ${n % 3 === 0
  ? `Step ${n + 1} is in src/app/main.ts. It reads the state, checks the input and writes the result, then opens a tab with the lines highlighted so you can read them in place.`
  : `Step ${n + 1} opened, and it has ${n + 3} tests.`}`

// The look is graded in one browser, and the faults are the app's, not the browser's: a second browser asking in the
// shared conversation at the same time would answer another test's fault. timeline.spec.ts proves the rail in WebKit.
requires("chromium")

const rail = (page: Page) => page.getByRole("navigation", { name: "Conversation timeline" })

/** Snapshot names are stable; a normal run fails when its reviewed reference is missing or differs. */
const snapshot = async (page: Page, name: string) => {
  await page.mouse.move(1100, 10);
  await expect(rail(page)).toHaveScreenshot(`${name}.png`, { animations: "disabled", caret: "hide", scale: "css", maxDiffPixelRatio: .001 });
  await page.screenshot({ path: `test-results/timeline-look/${name}.png` });
}
const bounded = async (page: Page) => {
  await expect.poll(() => rail(page).evaluate(element => {
    const height = element.querySelector<HTMLElement>(".sui-timeline-box")!.clientHeight;
    return [...element.querySelectorAll<HTMLElement>(".sui-tl-clip")].every(clip => clip.getBoundingClientRect().height <= height + 1);
  })).toBe(true);
  await expect.poll(async () => (await rail(page).evaluate(element => [...element.querySelectorAll<HTMLElement>(".sui-tl-lens")].map(lens => {
    const clip = lens.closest<HTMLElement>(".sui-tl-clip")!, bounds = clip.getBoundingClientRect(), rect = lens.getBoundingClientRect()
    return { level: Number(lens.dataset.lens), top: rect.top - bounds.top, bottom: rect.bottom - bounds.top,
      clipHeight: bounds.height, windowStart: Number(clip.dataset.windowStart), windowEnd: Number(clip.dataset.windowEnd),
      transform: lens.closest<HTMLElement>(".sui-tl-inner")!.style.transform }
  }))).filter(lens => lens.top < -1 || lens.bottom > lens.clipHeight + 1)).toEqual([]);
  await expect(rail(page).locator('.sui-tl-row .sui-tl-tx').first()).toHaveCSS("white-space", "nowrap");
  const paths = await rail(page).locator(".sui-tl-fun path[d]").evaluateAll(paths => paths.map(path => path.getAttribute("d")));
  expect(paths.every(path => !/NaN|Infinity/.test(path ?? ""))).toBe(true);
}

test("Timeline: phases read as what happened, levels arrive, and hover adds detail, against the mock", async ({ devices, request }) => {
  requires("timelineVisualFixture")
  test.setTimeout(540_000)
  expect(await shapeRows<Row>(request, "/api/shapes/messages"), "the exclusive fixture starts empty").toHaveLength(0)
  let a = await devices.openNew("Timeline look", scriptedAgent("echo"))
  mkdirSync("test-results/timeline-look", { recursive: true })
  const base = await rail(a.page).locator('ol[data-level="0"] button').count()
  expect(base, "visual references require an empty conversation on an exclusive fresh database").toBe(0)
  const fixtureIds: string[] = []
  let made = 0
  for (const [name, count] of Object.entries(LENGTHS)) {
    await test.step(`Grow to ${name}`, async () => {
      // A fixed settled batch reaches the real engine on opening, independent of API/Electric scheduling.
      await a.device.context.close()
      for (; made < count; made++) {
        const id = crypto.randomUUID(), answerId = crypto.randomUUID()
        expect((await request.post("/api/questions", { data: { id, answerId, text: question(made) } })).status()).toBe(202)
        expect((await request.post(`/api/answers/${answerId}`, { data: { status: "done", text: answer(made) } })).status()).toBe(200)
        fixtureIds.push(id, answerId)
      }
      a = await devices.openNew(`Timeline look ${name}`, scriptedAgent("echo"))
      // All recorded fixture IDs must arrive before grading total counts; a late dirty snapshot cannot satisfy an empty read.
      const recorded = fixtureIds.map(id => `[aria-controls="${id}"]`).join(",")
      await expect(rail(a.page).locator(`ol[data-level="0"] button:is(${recorded})`)).toHaveCount(count * 2, { timeout: 90_000 })
      await expect(rail(a.page).locator('ol[data-level="0"] button')).toHaveCount(count * 2, { timeout: 90_000 })
      // References capture completed summaries, never a race between pending labels and model receipts.
      await expect(rail(a.page).locator('ol[data-level="0"] [data-summary="ready"]')).toHaveCount(count * 2, { timeout: 120_000 })
    })
    if (name !== "short") await test.step(`Phases at ${name}`, async () => {
      type SemanticRow = Row & { phase?: string | null; arc?: string | null }
      let settled: SemanticRow[] = []
      await expect.poll(async () => {
        settled = (await shapeRows<SemanticRow>(request, "/api/shapes/messages")).sort((a, b) => Number(a.position) - Number(b.position))
        const messages = settled.map(row => ({ ...row, questionId: row.question_id }))
        return { rows: settled.length, phasePending: planOf(exchangeUnits(messages), 1) !== undefined, arcPending: planOf(phaseUnits(messages), 2) !== undefined }
      }, { timeout: 200_000 }).toEqual({ rows: count * 2, phasePending: false, arcPending: false })
      const messages = settled.map(row => ({ ...row, questionId: row.question_id }))
      for (const level of [1, 2] as const) {
        if (level === 2 && Number(await rail(a.page).getAttribute("data-levels")) < 3) continue
        const expected = railMarkers(messages, level === 1 ? "phase" : "arc").map(marker => ({ start: marker.start, end: fixtureIds.indexOf(marker.end!) + 1 }))
        await expect.poll(() => rail(a.page).evaluate((element, { level, expected }) => {
          const buttons = [...element.querySelectorAll<HTMLElement>(`ol[data-level="${level}"] button[data-summary="ready"]`)]
          return buttons.length === expected.length && buttons.every((button, index) =>
            button.getAttribute("aria-controls") === expected[index]!.start &&
            Math.max(0, ...[...button.querySelectorAll<HTMLElement>(".sui-tl-sm")].map(mark => Number(mark.dataset.end))) === expected[index]!.end)
        }, { level, expected }), { timeout: 30_000 }).toBe(true)
      }
      await test.info().attach(`${name}-summary-receipts`, { body: JSON.stringify({ entries: settled.length, phases: railMarkers(messages, "phase").length, arcs: railMarkers(messages, "arc").length }), contentType: "application/json" })
      await expect(rail(a.page).locator('ol[data-level="1"] [data-summary="ready"]')).not.toHaveCount(0)
      const titles = await rail(a.page).locator('ol[data-level="1"] button').allTextContents()
      expect(titles.join("|")).toContain("Working on")
      expect(titles.join("|")).not.toMatch(/\d+ entries/)
    })
    await a.page.locator('[data-slot="message-scroller-viewport"]').evaluate(el => { el.scrollTop = el.scrollHeight })
    for (const size of SIZES) for (const theme of ["light", "dark"] as const) await test.step(`${name} ${size.width} ${theme}`, async () => {
      await a.page.setViewportSize(size)
      await a.page.emulateMedia({ colorScheme: theme })
      await a.page.evaluate(wanted => { document.documentElement.dataset.theme = wanted }, theme)
      await a.page.waitForTimeout(600)
      await bounded(a.page)
      await snapshot(a.page, `${name}-${size.width}-${theme}`)
    })
  }
  await test.step("A single drag from the live edge loads unmounted middle history", async () => {
    const viewport = a.page.locator('[data-slot="message-scroller-viewport"]')
    await viewport.evaluate(el => { el.scrollTop = el.scrollHeight })
    await a.page.waitForTimeout(400)
    await rail(a.page).locator('[data-lens="1"]').hover()
    const lens = await rail(a.page).locator('[data-lens="1"]').boundingBox()
    const target = await rail(a.page).evaluate(element => {
      const clip = element.querySelector('.sui-tl-lv[data-level="1"] .sui-tl-clip')!, bounds = clip.getBoundingClientRect()
      for (const mark of clip.querySelectorAll<HTMLElement>(".sui-tl-sm")) {
        const rect = mark.getBoundingClientRect(), start = Number(mark.dataset.start), end = Number(mark.dataset.end)
        const row = start + .35 * (end - start), index = Math.floor(row)
        const id = element.querySelector(`[data-row="${index}"]`)?.getAttribute("aria-controls")
        if (start >= 10 && rect.top >= bounds.top && rect.bottom <= bounds.bottom && id && document.getElementById(id) === null) return { id, y: rect.top + .35 * rect.height, fraction: row - index }
      }
      return null
    })
    expect(target, "the detailed rail spans an unmounted middle exchange").not.toBeNull()
    expect(lens).not.toBeNull()
    await a.page.mouse.move(lens!.x + lens!.width / 2, lens!.y + lens!.height / 2)
    await a.page.mouse.down()
    await a.page.mouse.move(lens!.x + lens!.width / 2, target!.y, { steps: 1 })
    await a.page.mouse.up()
    await expect(a.page.locator(`[id="${target!.id}"]`)).toBeAttached()
    await expect(rail(a.page)).not.toHaveAttribute("data-navigation", "pending")
    await a.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const loadedGeometry = () => rail(a.page).evaluate((element, target) => {
      const row = Number((element as HTMLElement).dataset.readingRow), index = Math.floor(row)
      const id = element.querySelector(`[data-row="${index}"]`)?.getAttribute("aria-controls")
      const viewport = document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!
      const message = id ? document.getElementById(id) : null
      if (!message) return { error: Infinity, targetMatches: false, row }
      const rect = message.getBoundingClientRect(), frame = viewport.getBoundingClientRect()
      const y = rect.top - frame.top + viewport.scrollTop + (row - index) * rect.height
      const desired = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, y - viewport.clientHeight / 2))
      return { error: Math.abs(viewport.scrollTop - desired), targetMatches: id === target.id, row,
        requestedFraction: target.fraction, restoredY: Number((element as HTMLElement).dataset.readingY),
        restoredScroll: Number((element as HTMLElement).dataset.readingScroll), scrollTop: viewport.scrollTop, y, desired }
    }, target!)
    await test.info().attach("loaded-history-geometry", { body: JSON.stringify(await loadedGeometry()), contentType: "application/json" })
    expect((await loadedGeometry()).targetMatches).toBe(true)
    await expect.poll(async () => (await loadedGeometry()).error).toBeLessThanOrEqual(1.5)
  })
  await test.step("Scroll, and the rail follows", async () => {
    const viewport = a.page.locator('[data-slot="message-scroller-viewport"]')
    for (const fraction of [.8, .55, .3, .05, .5]) {
      await viewport.evaluate((el, at) => { el.scrollTop = el.scrollHeight * at }, fraction)
      await a.page.waitForTimeout(700)
    }
    await expect(rail(a.page).locator('ol[data-level="0"] [aria-current="location"]').first()).toBeAttached()
  })
  await test.step("Resize recomputes the windows, lenses and funnels", async () => {
    await a.page.setViewportSize({ width: 1440, height: 900 })
    await a.page.locator('[data-slot="message-scroller-viewport"]').evaluate(el => { el.scrollTop = el.scrollHeight / 2 })
    await a.page.waitForTimeout(600)
    await a.page.setViewportSize({ width: 1280, height: 640 })
    await a.page.waitForTimeout(600)
    await bounded(a.page)
    await snapshot(a.page, "long-resize-dark")
    await a.page.setViewportSize({ width: 1280, height: 800 })
  })
  await test.step("A lens retains its requested reading point after resize", async () => {
    const lens = rail(a.page).locator('[data-lens="1"]')
    const strip = rail(a.page).locator('.sui-tl-lv[data-level="1"] .sui-tl-clip')
    // Start from a known window and drag to a fixed exchange, independent of earlier window hysteresis.
    await a.page.locator('[data-slot="message-scroller-viewport"]').evaluate(el => { el.scrollTop = 0 })
    await expect(rail(a.page).locator('ol[data-level="0"] button').first()).toHaveAttribute("aria-current", "location")
    await lens.hover()
    const start = await lens.boundingBox(), bounds = await strip.boundingBox()
    expect(start).not.toBeNull(); expect(bounds).not.toBeNull()
    await a.page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2)
    const targetY = await strip.evaluate(element => {
      const row = 28.5
      const mark = [...element.querySelectorAll<HTMLElement>(".sui-tl-sm")].find(mark => Number(mark.dataset.start) <= row && Number(mark.dataset.end) > row)!
      const rect = mark.getBoundingClientRect()
      return rect.top + (row - Number(mark.dataset.start)) / (Number(mark.dataset.end) - Number(mark.dataset.start)) * rect.height
    })
    expect(targetY).toBeGreaterThan(bounds!.y)
    expect(targetY).toBeLessThan(bounds!.y + bounds!.height)
    await a.page.mouse.down()
    await a.page.mouse.move(start!.x + start!.width / 2, targetY, { steps: 12 })
    await a.page.mouse.up()
    await expect(rail(a.page)).not.toHaveAttribute("data-navigation", "pending")
    await a.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const dragGeometry = () => rail(a.page).evaluate(element => {
      const row = Number((element as HTMLElement).dataset.readingRow), index = Math.min(element.querySelectorAll(".sui-tl-row").length - 1, Math.floor(row))
      const id = element.querySelector(`[data-row="${index}"]`)?.getAttribute("aria-controls")
      const message = id === null || id === undefined ? null : document.getElementById(id)
      const viewport = document.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
      if (message === null || viewport === null) return { error: Infinity, hasRow: (element as HTMLElement).dataset.readingRow !== undefined,
        stage: (element as HTMLElement).dataset.dragStage, level: (element as HTMLElement).dataset.dragLevel, rows: element.querySelectorAll(".sui-tl-row").length }
      const rect = message.getBoundingClientRect(), frame = viewport.getBoundingClientRect()
      const point = rect.top + (row - index) * rect.height
      const currentY = point - frame.top + viewport.scrollTop
      const desired = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, currentY - viewport.clientHeight / 2))
      return { error: Math.abs(viewport.scrollTop - desired), row, point,
        viewportTop: frame.top, viewportHeight: frame.height, clientHeight: viewport.clientHeight,
        scrollTop: viewport.scrollTop, restoredScroll: Number((element as HTMLElement).dataset.readingScroll),
        restoredY: Number((element as HTMLElement).dataset.readingY), currentY, desired }
    })
    await test.info().attach("drag-geometry", { body: JSON.stringify(await dragGeometry()), contentType: "application/json" })
    await expect.poll(async () => (await dragGeometry()).error).toBeLessThanOrEqual(1.5)
    const requestedRow = await rail(a.page).getAttribute("data-reading-row")
    expect(requestedRow).not.toBeNull()
    // Resize after the drag: retain the ID/fraction and deliberately reselect a canonical window for the reference.
    // During the gesture the window holds by design, so event scheduling may otherwise leave a different held slice.
    for (const size of [{ width: 1280, height: 640 }, { width: 1280, height: 800 }]) {
      await a.page.setViewportSize(size)
      await expect(rail(a.page)).toHaveAttribute("data-reading-row", requestedRow!)
      await expect.poll(async () => (await dragGeometry()).error).toBeLessThanOrEqual(1.5)
      await bounded(a.page)
    }
    await snapshot(a.page, "long-drag-dark")
  })
  await test.step("The phone sheet and reduced motion retain bounded geometry", async () => {
    await a.page.setViewportSize({ width: 390, height: 844 })
    await a.page.emulateMedia({ reducedMotion: "reduce" })
    const disclosure = a.page.locator(".sui-timeline-disclosure")
    await disclosure.locator("summary").click()
    // Capture the live edge explicitly: opening the differently sized sheet releases the desktop drag anchor.
    const viewport = a.page.locator('[data-slot="message-scroller-viewport"]')
    await viewport.evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect(rail(a.page).locator('ol[data-level="0"] button').last()).toHaveAttribute("aria-current", "location")
    for (const theme of ["light", "dark"] as const) {
      await a.page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await a.page.evaluate(wanted => { document.documentElement.dataset.theme = wanted }, theme)
      await bounded(a.page)
      await snapshot(a.page, `long-phone-reduced-${theme}`)
    }
    await a.page.keyboard.press("Escape")
    await expect(disclosure).not.toHaveAttribute("open", "")
    await a.page.setViewportSize({ width: 1280, height: 800 })
    await viewport.evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect(rail(a.page).locator('ol[data-level="0"] button').last()).toHaveAttribute("aria-current", "location")
    await bounded(a.page)
    await snapshot(a.page, "long-desktop-reduced-dark")
    await a.page.emulateMedia({ reducedMotion: "no-preference" })
  })
  await test.step("Hover adds a phase's detail; its title was already there", async () => {
    const block = rail(a.page).locator('ol[data-level="1"] button[data-in][data-summary="ready"]').first()
    await block.hover()
    const tip = rail(a.page).getByRole("tooltip")
    await expect(tip).toBeVisible()
    await expect(tip).toContainText("messages")
    await expect(tip).toContainText("finished after a few runs")
    await a.page.waitForTimeout(900)
  })
  await test.step("A phase jumps to where it starts", async () => {
    const block = rail(a.page).locator('ol[data-level="1"] button[data-in][data-summary="ready"]').first()
    const target = await block.getAttribute("aria-controls")
    await block.click()
    await expect(a.page.locator(`[id="${target}"]`)).toBeInViewport()
    await a.page.mouse.move(1000, 20)
    await a.page.waitForTimeout(600)
  })
})

// A real conversation of mixed lengths: each mark at its message's place in the transcript (FE-22).
const LONG = Array.from({ length: 60 }, (_, line) => `Line ${line + 1} of the long answer: the checkout suite passed on the branch and the login redirect stayed green.`).join("\n\n")
const SHOTS = `${process.env.HOME}/Desktop/smithers-mvp/timeline`

test("Timeline: marks sit where their messages are, the band matches the screen, and phase titles read at every width", async ({ devices, request }) => {
  test.setTimeout(360_000)
  const [a] = await devices.open("Timeline spacing")
  await a.page.goto(scriptedAgent("echo"))
  await a.ready()
  mkdirSync("test-results/timeline-look", { recursive: true })
  const row = rail(a.page).locator('ol[data-level="0"] button')
  const base = await row.count()
  for (let n = 0; n < 14; n++) {
    const id = crypto.randomUUID(), answerId = crypto.randomUUID()
    expect((await request.post("/api/questions", { data: { id, answerId, text: question(n) } })).status()).toBe(202)
    expect((await request.post(`/api/answers/${answerId}`, { data: { status: "done", text: n % 4 === 1 ? `Topic: ${topicOf(n)}.\n\n${LONG}` : answer(n) } })).status()).toBe(200)
  }
  await expect.poll(() => row.count(), { timeout: 90_000 }).toBeGreaterThanOrEqual(base + 28)
  await expect.poll(() => rail(a.page).locator('ol[data-level="1"] [data-summary="ready"]').count(), { timeout: 200_000 }).toBeGreaterThan(1)
  const viewport = a.page.locator('[data-slot="message-scroller-viewport"]')
  for (const size of [{ width: 1190, height: 785 }, { width: 1440, height: 900 }] as const) await test.step(`Geometry at ${size.width}`, async () => {
    await a.page.setViewportSize(size)
    await viewport.evaluate(el => { el.scrollTop = el.scrollHeight })
    await a.page.waitForTimeout(800)
    await expect(async () => {
      const seen = await rail(a.page).locator('ol[data-level="0"]').evaluate(list => {
        const clip = list.closest(".sui-tl-clip")!.getBoundingClientRect()
        return [...list.querySelectorAll<HTMLElement>("button")].flatMap(button => {
          const mark = button.getBoundingClientRect(), message = document.getElementById(button.getAttribute("aria-controls")!)?.getBoundingClientRect()
          return message === undefined || mark.top < clip.top - 1 || mark.top > clip.bottom ? [] : [{ top: mark.top, height: mark.height, messageTop: message.top, messageHeight: message.height }]
        })
      })
      expect(seen.length).toBeGreaterThan(4)
      const first = seen[0]!, last = seen.at(-1)!
      const scale = (last.top - first.top) / (last.messageTop - first.messageTop)
      expect(scale).toBeGreaterThan(0)
      for (const mark of seen) {
        expect(Math.abs(mark.top - first.top - (mark.messageTop - first.messageTop) * scale)).toBeLessThan(3)
        expect(Math.abs(mark.height - Math.max(3, mark.messageHeight * scale))).toBeLessThan(3)
      }
      expect(Math.max(...seen.map(mark => mark.height))).toBeGreaterThan(Math.min(...seen.map(mark => mark.height)) * 4)
      const band = await rail(a.page).locator(".sui-tl-thumb").evaluate(el => el.getBoundingClientRect().height)
      const screen = await viewport.evaluate(el => el.clientHeight)
      expect(Math.abs(band - Math.max(6, screen * scale))).toBeLessThan(screen * scale * .2 + 3)
    }).toPass({ timeout: 15_000 })
    const titles = await rail(a.page).locator('ol[data-level="1"] .sui-tl-tx').evaluateAll(spans => spans.map(span => ({ text: span.textContent, width: span.clientWidth, needed: span.scrollWidth })))
    expect(titles.length).toBeGreaterThan(1)
    for (const title of titles) {
      expect(title.width, title.text!).toBeGreaterThanOrEqual(60)
      expect(title.needed, title.text!).toBeLessThanOrEqual(title.width)
    }
    for (const theme of ["light", "dark"] as const) {
      await a.page.emulateMedia({ colorScheme: theme })
      await a.page.evaluate(wanted => { document.documentElement.dataset.theme = wanted }, theme)
      await a.page.waitForTimeout(400)
      await a.page.screenshot({ path: `test-results/timeline-look/spacing-${size.width}x${size.height}-${theme}.png` })
      await a.page.screenshot({ path: `${SHOTS}/spacing-${size.width}x${size.height}-${theme}.png` })
    }
  })
  await test.step("A long answer's mark jumps to it", async () => {
    const tallest = await row.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height).reduce((best, height, index, all) => height > all[best]! ? index : best, 0))
    await row.nth(tallest).locator(".sui-tl-mk").click({ force: true })
    await expect(a.page.locator(`[id="${await row.nth(tallest).getAttribute("aria-controls")}"]`)).toBeInViewport()
  })
})

for (const [word, code, text] of [["no_route", "unconfigured", "No summary model is set"], ["out_of_credit", "credit", "The summary model is out of credit"], ["quota_exceeded", "capped", "Today's summaries are spent"], ["provider_internal", "unavailable", "The summary model isn't answering"]] as const) {
  test(`Timeline: summaries that can't be made say so (${code})`, async ({ devices, request }) => {
    test.setTimeout(180_000)
    const [a] = await devices.open(`Timeline ${code}`)
    // Recorded before the page opens, so it is the newest message and the first the tab asks about.
    const id = crypto.randomUUID(), answerId = crypto.randomUUID()
    const said = `Topic: failing. summaries-fail:${word} ${crypto.randomUUID()}`
    expect((await request.post("/api/questions", { data: { id, answerId, text: said } })).status()).toBe(202)
    expect((await request.post(`/api/answers/${answerId}`, { data: { status: "done", text: said } })).status()).toBe(200)
    await a.page.goto(scriptedAgent("echo"))
    await a.ready()
    // The rail marks what's missing a summary; the toast lasts 4 s, and its entry stays in the bell's list.
    await expect.poll(() => rail(a.page).locator('[data-summary="unavailable"]').count(), { timeout: 120_000 }).toBeGreaterThan(0)
    await a.page.keyboard.press("Alt+n")
    await expect(a.page.getByRole("dialog", { name: "Notifications" }).getByText(text)).toBeVisible({ timeout: 15_000 })
    await a.page.keyboard.press("Escape")
    await a.page.waitForTimeout(800)
  })
}
