import type { Page } from "@playwright/test"
import { mkdirSync } from "node:fs"
import { expect, test } from "./devices"
import { requires, scriptedAgent } from "./target"

// The rail against the approved mock (docs/design/timeline): screenshots of a real conversation at the two desktop
// sizes, in both themes, at three lengths, beside the mock's own (test-results/timeline-look/).
requires("scriptedAgent", "member")

const LENGTHS = { short: 3, medium: 20, long: 90 } as const
const SIZES = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }] as const

// Phases of different sizes, as a real chat has: the scripted summary model starts a span where the topic changes.
const STRETCHES = [["issue 450", 7], ["checkout tests", 3], ["review 104", 5], ["login redirect", 9], ["coupon rules", 4], ["release notes", 6], ["search index", 2], ["payment form", 8]] as const
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
test.skip(({ browserName }) => browserName === "webkit", "Chromium only")

const rail = (page: Page) => page.getByRole("navigation", { name: "Conversation timeline" })

test("Timeline: phases read as what happened, levels arrive, and hover adds detail, against the mock", async ({ devices, request }) => {
  test.setTimeout(540_000)
  const [a] = await devices.open("Timeline look")
  await a.page.goto(scriptedAgent("echo"))
  await a.ready()
  mkdirSync("test-results/timeline-look", { recursive: true })
  const base = await rail(a.page).locator('ol[data-level="0"] button').count()
  let made = 0
  for (const [name, count] of Object.entries(LENGTHS)) {
    await test.step(`Grow to ${name}`, async () => {
      for (; made < count; made++) {
        const id = crypto.randomUUID(), answerId = crypto.randomUUID()
        expect((await request.post("/api/questions", { data: { id, answerId, text: question(made) } })).status()).toBe(202)
        expect((await request.post(`/api/answers/${answerId}`, { data: { status: "done", text: answer(made) } })).status()).toBe(200)
      }
      await expect.poll(() => rail(a.page).locator('ol[data-level="0"] button').count(), { timeout: 90_000 }).toBeGreaterThanOrEqual(base + count * 2)
    })
    if (name !== "short") await test.step(`Phases at ${name}`, async () => {
      await expect.poll(() => rail(a.page).locator('ol[data-level="1"] [data-summary="ready"]').count(), { timeout: 200_000 }).toBeGreaterThan(1)
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
      await a.page.screenshot({ path: `test-results/timeline-look/${name}-${size.width}-${theme}.png` })
    })
  }
  await test.step("Scroll, and the rail follows", async () => {
    const viewport = a.page.locator('[data-slot="message-scroller-viewport"]')
    for (const fraction of [.8, .55, .3, .05, .5]) {
      await viewport.evaluate((el, at) => { el.scrollTop = el.scrollHeight * at }, fraction)
      await a.page.waitForTimeout(700)
    }
    await expect(rail(a.page).locator('ol[data-level="0"] [aria-current="location"]').first()).toBeAttached()
  })
  await test.step("Hover adds a phase's detail; its title was already there", async () => {
    const block = rail(a.page).locator('ol[data-level="1"] button').first()
    await block.hover()
    const tip = rail(a.page).getByRole("tooltip")
    await expect(tip).toBeVisible()
    await expect(tip).toContainText("messages")
    await expect(tip).toContainText("finished after a few runs")
    await a.page.waitForTimeout(900)
  })
  await test.step("A phase jumps to where it starts", async () => {
    const blocks = rail(a.page).locator('ol[data-level="1"] button')
    await blocks.nth(2).click()
    const target = await blocks.nth(2).getAttribute("aria-controls")
    await expect(a.page.locator(`[id="${target}"]`)).toBeInViewport()
    await a.page.mouse.move(1000, 20)
    await a.page.waitForTimeout(600)
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
