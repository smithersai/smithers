import { expect, test } from "./devices"
import { requires } from "./target"
import { expectServerError } from "./watch"

requires("localServer", "member", "hostedModelOff")
test.use({ trace: "off" })

const repository = "octocat/Spoon-Knife"
// Headers include the list's second row, not just the repository's top bar.
const controls = 'header button, header a, [role="toolbar"] button, [role="toolbar"] a, .home-tabs a, .landing-top a, .branch-header button, .branch-header a, .mvp-pin-actions button, .sui-button-solid, .sui-button-default, .sui-rh-action-primary, [data-primary-action]'

for (const viewport of [{ width: 1190, height: 785 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`New TODO receives a click with Add your model at ${viewport.width}x${viewport.height}`, async ({ devices }) => {
    const [tab] = await devices.open("New TODO")
    const page = tab.page
    await page.setViewportSize(viewport)
    await page.goto(`/${repository}/stack`)
    const notice = page.locator('[data-slot="toast"][data-add-model]')
    await expect(notice).toBeInViewport({ ratio: 1, timeout: 60_000 })
    await expect.poll(() => notice.evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1)
    await page.getByRole("button", { name: "New TODO", exact: true }).click({ timeout: 5_000 })
    await expect(page.getByRole("form", { name: "TODO draft" })).toBeVisible()
    await expect(notice).toBeInViewport({ ratio: 1 })
  })

  test(`page controls stay clear of toasts at ${viewport.width}x${viewport.height}`, async ({ devices }) => {
    test.setTimeout(240_000)
    const [tab] = await devices.open("Page controls")
    const page = tab.page
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: viewport.width === 390 ? "reduce" : "no-preference" })
    const pages = [
      { name: "Home", path: "/" },
      { name: "Conversations", path: "/app/conversations" },
      { name: "Conversation", path: "/app" },
      { name: "Repository", path: `/${repository}` },
      { name: "Issues", path: `/${repository}/issues` },
      { name: "Pull requests", path: `/${repository}/pulls` },
      { name: "Stack", path: `/${repository}/stack` },
      { name: "Runs", path: `/${repository}/runs` },
      { name: "Settings", path: "/app/settings" },
      { name: "Branch", path: `/${repository}/tree/main` },
    ]
    for (const { name, path } of pages) {
      await test.step(name, async () => {
        await page.goto(path)
        const notice = page.locator('[data-slot="toast"][data-add-model]')
        if (path === "/") {
          // The landing page has no feed owner; its primary action must still receive clicks.
          await expect(page.getByRole("link", { name: "Open Smithers", exact: true })).toBeVisible({ timeout: 60_000 })
          await expect(notice).toHaveCount(0)
        } else {
          await expect(notice).toBeInViewport({ ratio: 1, timeout: 60_000 })
          await expect.poll(() => notice.evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1)
          await page.evaluate(() => window.scrollTo(0, 0))
          await expect(page.locator("header").first()).toBeInViewport()
        }
        if (path.endsWith("/stack")) await expect(page.getByRole("button", { name: "New TODO", exact: true })).toBeVisible()
        await expect.poll(() => page.evaluate((selector) => {
          const toasts = [...document.querySelectorAll('[data-slot="toast"]')].map(element => element.getBoundingClientRect())
          return [...document.querySelectorAll<HTMLElement>(selector)].filter(element => !element.closest('[data-slot="toast-stack"], .sui-msg-scroller, .sui-chat-messages')).flatMap(element => {
            const box = element.getBoundingClientRect()
            if (box.width === 0 || box.height === 0 || box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth || getComputedStyle(element).visibility === "hidden") return []
            // Horizontally scrolling header tabs outside their clip are not visible controls.
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent), clip = parent.getBoundingClientRect()
              if ((["auto", "scroll", "hidden", "clip"].includes(style.overflowX) && (box.left < clip.left || box.right > clip.right)) ||
                  (["auto", "scroll", "hidden", "clip"].includes(style.overflowY) && (box.top < clip.top || box.bottom > clip.bottom))) return []
            }
            const overlap = toasts.some(toast => toast.left < box.right && toast.right > box.left && toast.top < box.bottom && toast.bottom > box.top)
            const hit = element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
            return overlap || !hit ? [{ control: element.textContent?.trim() || element.getAttribute("aria-label"), overlap, hit }] : []
          })
        }, controls), { message: `${path}: header and primary actions receive pointers` }).toEqual([])
      })
    }
  })
}


test("scrolling a conversation keeps its toast at the header anchor", async ({ devices }) => {
  test.setTimeout(180_000)
  expectServerError(409, "/api/model/*")
  const [tab] = await devices.open("Conversation scroll")
  const page = tab.page
  await page.setViewportSize({ width: 390, height: 844 })
  const first = { id: crypto.randomUUID(), answerId: crypto.randomUUID() }
  const later = { id: crypto.randomUUID(), answerId: crypto.randomUUID() }
  try {
    expect((await page.request.post("/api/questions", { data: { ...first, text: `Choose next ${devices.word}` } })).status()).toBe(202)
    expect((await page.request.post(`/api/runs/${first.answerId}`, { data: {
      status: "needs_you", wait: { execution: `toast-scroll-${first.answerId}`, kind: "question", prompt: "What next?", options: [] },
    } })).status()).toBe(200)
    expect((await page.request.post("/api/questions", { data: { ...later, text: "Later context. ".repeat(500) } })).status()).toBe(202)
    const card = page.locator(`[data-slot="needs-you"][data-run="${first.answerId}"]`)
    const answer = card.getByRole("button", { name: "Answer", exact: true })
    await expect(answer).toBeVisible({ timeout: 60_000 })
    const stack = page.locator('[data-slot="toast-stack"]')
    const model = page.locator('[data-slot="toast"][data-add-model]')
    await expect(model).toBeInViewport({ ratio: 1, timeout: 30_000 })
    const before = (await stack.boundingBox())!.y
    const viewport = page.locator('[data-slot="message-scroller-viewport"]')
    await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200)
    const scrollBefore = await viewport.evaluate(element => element.scrollTop)
    // Real pending question, real Answer, and real transcript scrolling. The toast
    // overlays conversation content; it must not chase a message's buttons.
    await expect.poll(() => answer.evaluate((element, top) => {
      const scroller = element.closest('[data-slot="message-scroller-viewport"]')!
      scroller.scrollTop += element.getBoundingClientRect().top - top
      return Math.abs(element.getBoundingClientRect().top - top)
    }, before + 8)).toBeLessThan(2)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await viewport.evaluate(element => element.scrollTop)).not.toBe(scrollBefore)
    expect((await stack.boundingBox())!.y).toBe(before)
    await expect(model).toBeInViewport({ ratio: 1 })
  } finally {
    for (const { answerId } of [first, later]) await page.request.post(`/api/answers/${answerId}`, { data: { status: "failed", failure: "unfinished" } })
  }
})
