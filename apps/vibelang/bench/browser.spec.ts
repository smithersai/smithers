// Stays .ts: Playwright collects test files by JS/TS extension only; browser callbacks need its DOM host.
import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import { collectBrowserCoverage as collectCoverage, save as saveArtifact } from "./browser-support.ts"
import { performance } from "node:perf_hooks"
const live = process.env.BENCH_LIVE === "1"
let deploymentRevision: string | null = null
test.beforeAll(async ({ baseURL }) => {
  if (!live) return
  const health = await fetch(`${baseURL}/api/health`)
  expect(health.status).toBe(200)
  const body = await health.json()
  expect(body).toMatchObject({ ok: true, agent: "live" })
  if (typeof body.commit === "string") {
    expect(body.commit).toMatch(/^[0-9a-f]{10,40}$/)
    deploymentRevision = body.commit
  }
})

const save = (name: string, measurements: unknown, limitations: string[]) => saveArtifact(name, measurements, limitations, { live, deploymentRevision })
const collectBrowserCoverage = (context: BrowserContext, page: Page, baseURL: string | undefined, name: string) => collectCoverage(context, page, baseURL, name, { live, dist: "dist" })

// A first visit to "/" starts the tour 1.2 s after load. These workloads drive the page themselves, so each visit is
// marked toured, as the e2e specs do; otherwise the tour's overlay takes a click that comes later than 1.2 s. A tab
// whose session holds `bench:first-visit` is the arms workload's measured first visit, so it stays unmarked.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { if (sessionStorage.getItem("bench:first-visit") !== "yes") localStorage.setItem("vibelang:toured", "yes") }) })

test("first render, Command-K and per-keystroke browser latency", async ({ browser, baseURL }) => {
  const samples = []
  for (let run = 0; run < 3; run++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" })
    await context.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
    let coverage: (() => Promise<void>) | undefined
    try {
      const page = await context.newPage()
      coverage = await collectBrowserCoverage(context, page, baseURL, `render-${run}`)
      const begin = performance.now()
      await page.goto(live ? `${baseURL}/` : `${baseURL}/?agent=mock`, { waitUntil: "commit" })
      await expect(page.getByRole("heading", { name: "VibeLang", exact: true })).toBeVisible()
      const firstRenderMs = performance.now() - begin
      const key = performance.now()
      await page.keyboard.press("Meta+k")
      await expect(page.getByRole("dialog", { name: "Ask the agent" })).toBeVisible()
      const prompt = page.getByRole("textbox", { name: "Message" })
      await expect(prompt).toBeFocused()
      const commandKMs = performance.now() - key
      const typing = performance.now()
      await prompt.pressSequentially("x")
      await expect(prompt).toHaveValue("x")
      samples.push({ run, firstRenderMs, commandKMs, keystrokeMs: performance.now() - typing })
    } finally { try { if (coverage) await coverage() } finally { await context.close() } }
  }
  await save(live ? "live-browser" : "local-browser", { origin: baseURL, browserVersion: browser.version(), samples }, [
    live ? "Default production backend selection; UI-only navigation and keys make no model call. Fresh context marked as a returning visitor to suppress the automatic tour, shared browser/OS caches and automation overhead; no forced cold cache." : "Product mock mode, fresh browser context marked as a returning visitor to suppress the automatic tour, shared browser/OS caches and automation overhead; no forced cold cache.",
  ])
})

test("post acceptance, first event, first answer delta, settlement, fresh/warm API", async ({ baseURL }) => {
  test.skip(!live, "Production inference is opt in through pnpm bench:live.")
  const samples: Record<string, unknown>[] = []
  try {
    const health = await fetch(`${baseURL}/api/health`)
    const healthBody = await health.json()
    expect(healthBody).toMatchObject({ ok: true, agent: "live" })
    if (deploymentRevision !== null) expect(healthBody.commit).toBe(deploymentRevision)
    for (let run = 0; run < 3; run++) {
      const room = `bench-${Date.now()}-${run}`
      const path = `${baseURL}/api/conversations/${room}`
      const fresh = performance.now()
      const first = await fetch(path)
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({ seq: 0, entries: [] })
      const freshObjectMs = performance.now() - fresh
      const warm = performance.now()
      const again = await fetch(path)
      expect(await again.json()).toEqual({ seq: 0, entries: [] })
      const warmObjectMs = performance.now() - warm
      const controller = new AbortController()
      const deadline = setTimeout(() => controller.abort(), 120_000)
      const sample: Record<string, unknown> = { run, freshObjectMs, warmObjectMs, timestamp: new Date().toISOString(), passed: false }
      samples.push(sample)
      try {
        const start = performance.now()
        const accepting = fetch(`${path}/posts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: `bench-${run}`, name: "Benchmark", text: "Reply with one short sentence describing VibeLang." }), signal: controller.signal }).then(async response => {
          sample.acceptanceMs = performance.now() - start
          expect(response.status).toBe(200)
          await response.text()
        })
        await accepting
        const stream = await fetch(`${path}/events`, { signal: controller.signal })
        expect(stream.status).toBe(200)
        expect(stream.headers.get("content-type")).toContain("text/event-stream")
        const reader = stream.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = "", sequence = 0, text = "", done = false
        while (!done) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error("SSE ended before settlement")
          buffer += decoder.decode(chunk.value, { stream: true })
          buffer = buffer.replaceAll("\r\n", "\n")
          let boundary: number
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            const data = frame.split("\n").find(line => line.startsWith("data:"))?.slice(5).trim()
            if (!data) continue
            const event = JSON.parse(data)
            expect(event.seq).toBe(++sequence)
            sample.firstEventMs ??= performance.now() - start
            if (event.type === "ReplyDelta") { text += event.text; sample.firstAnswerDeltaMs ??= performance.now() - start }
            if (event.type === "ReplyRestarted") text = ""
            if (event.type === "ReplyFailed") { sample.failure = "agent-reply-failed"; throw new Error("Production reply failed") }
            if (event.type === "ReplyFinished") { sample.settledMs = performance.now() - start; done = true }
          }
        }
        await accepting
        await reader.cancel()
        expect(text.trim().length).toBeGreaterThan(0)
        sample.events = sequence
        sample.answerCharacters = text.length
        const snapshot = await (await fetch(path)).json()
        expect(snapshot.seq).toBe(sequence)
        expect(snapshot.entries[0]).toMatchObject({ clientId: `bench-${run}`, text: "Reply with one short sentence describing VibeLang." })
        expect(snapshot.entries.at(-1)).toMatchObject({ text, done: true, error: "" })
        sample.passed = true
      } finally { clearTimeout(deadline); controller.abort() }
    }
  } finally {
    await save("live-api", { origin: baseURL, samples }, [
      "Real model tokens, opt in. Fresh object vs repeated read cannot force a cold Worker isolate; network/PoP/provider/cache/budget contention are uncontrolled. First answer delta is the first projected visible token, not the provider's first raw token (the protocol does not expose that). Three samples do not establish percentiles. A failure field is unsuccessful evidence, not a latency claim.",
    ])
  }
})

test("chat, scroll, home, tour and escape actions", async ({ page, baseURL }) => {
  test.skip(live, "This workload measures product mock mode; production model work is separately opt in.")
  const timings: { action: string; ms: number; passed: boolean }[] = []
  const coverage = await collectBrowserCoverage(page.context(), page, baseURL, "chat")
  const time = async (action: string, body: () => Promise<void>) => {
    const start = performance.now(); let passed = false
    try { await body(); passed = true } finally { timings.push({ action, ms: performance.now() - start, passed }) }
  }
  try {
    // A first visit starts the tour after 1.2 s on its own; this journey measures chat, so it visits as a returning
    // person. The arms workload measures the first-visit tour.
    await page.addInitScript(() => localStorage.setItem("vibelang:toured", "yes"))
    await page.goto(`${baseURL}/?agent=mock`)
    const hero = page.locator(".vl-media video")
    await time("hero-ready-frame", async () => {
      await expect(hero).toHaveAttribute("poster", "/media/contract-poster.jpg")
      await expect.poll(() => hero.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2)
      const frame = await hero.evaluate((video: HTMLVideoElement) => new Promise<{ width: number; height: number }>(resolve => video.requestVideoFrameCallback((_now, frame) => resolve({ width: frame.width, height: frame.height }))))
      expect(frame.width).toBeGreaterThan(0)
      expect(frame.height).toBeGreaterThan(0)
    })
    await time("hero-native-pause", async () => {
      await hero.evaluate((video: HTMLVideoElement) => video.pause())
      await expect(hero).toHaveJSProperty("paused", true)
    })
    await time("hero-native-play", async () => {
      await hero.evaluate((video: HTMLVideoElement) => video.play())
      await expect(hero).toHaveJSProperty("paused", false)
    })
    await time("ask-button", async () => {
      await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
      await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
    })
    for (let index = 0; index < 4; index++) {
      await time(`submit-settle-${index}`, async () => {
        const input = page.getByRole("textbox", { name: "Message" })
        await input.fill("What is a service?")
        await input.press("Enter")
        await expect(page.locator("[data-role='assistant'][data-done='true']")).toHaveCount(index + 1)
        await expect(page.locator("[data-role='assistant']").last()).toContainText("service")
      })
    }
    await time("wheel-pause", async () => {
      await page.mouse.move(40, 400)
      await page.mouse.wheel(0, -10000)
      await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeVisible()
    })
    await time("latest", async () => {
      await page.getByRole("button", { name: "Latest", exact: true }).click()
      await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
      await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
    })
    for (const key of ["Home", "PageUp", "ArrowUp", "Control+Home", "Meta+ArrowUp"]) {
      await time(`pause-${key}`, async () => {
        await page.locator("body").evaluate(element => { element.tabIndex = -1; element.focus({ preventScroll: true }) })
        await expect(page.locator("body")).toBeFocused()
        await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
        const before = await page.evaluate(() => window.scrollY)
        await page.keyboard.press(key)
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(before)
        await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeVisible()
        await page.getByRole("button", { name: "Latest", exact: true }).click()
        await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
        await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight - window.scrollY)).toBeLessThanOrEqual(48)
      })
    }
    await time("new-input-cancels-latest", async () => {
      await page.locator("body").evaluate(element => { element.tabIndex = -1; element.focus({ preventScroll: true }) })
      await page.keyboard.press("Home")
      await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Latest", exact: true }).click()
      await page.mouse.move(40, 400)
      await page.mouse.wheel(0, -10000)
      await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeVisible()
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      await page.getByRole("button", { name: "Latest", exact: true }).click()
      await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
    })
    await time("touch-pause", async () => {
      await page.evaluate(() => {
        const target = document.body
        target.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [new Touch({ identifier: 1, target, clientY: 100 })] }))
        target.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [new Touch({ identifier: 1, target, clientY: 200 })] }))
        target.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [] }))
        target.dispatchEvent(new TouchEvent("touchcancel", { bubbles: true, touches: [] }))
      })
      await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Latest", exact: true }).click()
      await expect(page.getByRole("button", { name: "Latest", exact: true })).toBeHidden()
    })
    const actions = page.getByRole("region", { name: "Actions", exact: true })
    await time("actions-open", async () => {
      await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
      await actions.getByRole("button", { name: "Tour", exact: true }).click()
      await expect(actions.getByText("No runs yet", { exact: true })).toBeVisible()
    })
    const cards = page.getByRole("button", { name: /^Open Tour run / })
    let previousRun = ""
    await time("actions-run-and-trace", async () => {
      await actions.getByRole("button", { name: "Run", exact: true }).click()
      await expect(cards).toHaveCount(1)
      previousRun = (await cards.first().getAttribute("aria-label"))!
      await cards.first().click()
      await expect(actions).toHaveAttribute("data-maximized", "true")
      await expect(actions.getByLabel("Logs", { exact: true })).toContainText(/start|guide/)
    })
    await time("actions-cancel", async () => {
      await actions.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(actions.getByText("Cancelled", { exact: true }).first()).toBeVisible()
    })
    await time("actions-rerun", async () => {
      await actions.getByRole("button", { name: "Re-run", exact: true }).click()
      await expect(cards).toHaveCount(2)
      const next = await cards.first().getAttribute("aria-label")
      expect(next).not.toBe(previousRun)
      await expect(actions).toContainText(`#${next!.replace("Open Tour run ", "")}`)
      await actions.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(actions.getByText("Cancelled", { exact: true }).first()).toBeVisible()
    })
    await time("actions-escape-collapse", async () => {
      await page.keyboard.press("Escape")
      await expect(actions).toHaveAttribute("data-maximized", "false")
      await actions.getByRole("button", { name: "Collapse Actions", exact: true }).click()
      await expect(page.getByRole("button", { name: "Expand Actions", exact: true })).toBeVisible()
      await expect(page.locator('form[data-docked="true"]').getByRole("textbox", { name: "Message", exact: true })).toBeEnabled()
    })
    await time("home-expand-minimize", async () => {
      await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
      await expect(page.getByRole("heading", { name: "VibeLang", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Minimize the VibeLang home page" }).click()
      await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
    })
    await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
    const theatre = page.getByRole("region", { name: "Walkthrough", exact: true })
    await time("learn-more", async () => {
      await page.getByRole("button", { name: "Learn more", exact: true }).click()
      await expect(page.getByRole("button", { name: "Esc", exact: true })).toBeVisible()
      await expect(theatre).toHaveAttribute("data-step", "1")
      await expect(theatre).toContainText("I'm the VibeLang agent.")
    })
    await time("tour-pause", async () => {
      await page.getByRole("button", { name: "Pause", exact: true }).click()
      await expect(theatre).toHaveAttribute("data-paused", "true")
    })
    await time("tour-resume", async () => {
      await page.getByRole("button", { name: "Play", exact: true }).click()
      await expect(theatre).toHaveAttribute("data-paused", "false")
    })
    const stepChecks: Record<number, () => Promise<void>> = {
      2: async () => { await expect(page.locator('[data-role="user"]')).toContainText("What makes VibeLang different from TypeScript?") },
      3: async () => { await expect(page.locator(".ix-surface")).toBeVisible() },
      4: async () => { await expect(page.locator(".sui-item-conv")).toContainText("#48") },
      5: async () => { await expect(page.locator(".sui-item-conv")).toContainText("#45") },
      6: async () => { await expect(page.getByRole("region", { name: "Wiki", exact: true })).toHaveAttribute("data-maximized", "true") },
    }
    for (let step = 2; step <= 6; step++) await time(`tour-skip-${step}`, async () => {
      await page.getByRole("button", { name: "Skip", exact: true }).click()
      await expect(theatre).toHaveAttribute("data-step", String(step))
      await stepChecks[step]!()
    })
    await time("escape-tour", async () => {
      await page.keyboard.press("Escape")
      await expect(page.getByRole("button", { name: "Esc", exact: true })).toBeHidden()
      await expect(page.getByRole("status", { name: "Tour", exact: true })).toHaveText("Tour ended. You have control.")
    })
    const wiki = page.getByRole("region", { name: "Wiki", exact: true })
    await expect(wiki).toHaveAttribute("data-maximized", "false")
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
    await time("wiki-maximize", async () => {
      await page.getByRole("button", { name: "Maximize the wiki" }).click()
      await expect(wiki).toHaveAttribute("data-maximized", "true")
    })
    await time("wiki-minimize", async () => {
      await page.getByRole("button", { name: "Minimize the wiki" }).click()
      await expect(wiki).toHaveAttribute("data-maximized", "false")
    })
    await page.getByRole("button", { name: "Maximize the wiki" }).click()
    await time("escape-wiki", async () => {
      await page.keyboard.press("Escape")
      await expect(wiki).toHaveAttribute("data-maximized", "false")
    })
  } finally {
    if (coverage) await coverage()
    await save("local-browser-actions", { origin: baseURL, timings }, ["One serial native-browser journey with real Foldkit and product MockFactory; timings include scripted delays and automation. External docs content is not asserted; only the correct pane URL and controls. Video timing begins after navigation; ready-state/decoded-frame observation and native programmatic pause/play include automation, browser caches and software decode, without physical control interaction. Touch is dispatched as native synthetic DOM events, not physical hardware. Single observations establish no percentile."])
  }
})


test("history navigation, planning, notes, approval and folding", async ({ page, baseURL }) => {
  test.skip(live, "History writes use the product mock; production callers remain viewers until sign-in lands.")
  const timings: { action: string; ms: number; passed: boolean }[] = []
  const coverage = await collectBrowserCoverage(page.context(), page, baseURL, "history")
  const time = async (action: string, body: () => Promise<void>) => {
    const start = performance.now(); let passed = false
    try { await body(); passed = true } finally { timings.push({ action, ms: performance.now() - start, passed }) }
  }
  try {
    await time("history-first-render", async () => {
      await page.goto(`${baseURL}/history?agent=mock`)
      await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 30000 })
      await expect(page.getByText("Mock", { exact: true })).toBeVisible()
    })
    await time("history-epic-keyboard", async () => {
      const header = page.getByRole("button", { name: /The compiler/ })
      await header.focus()
      await page.keyboard.press("Enter")
      await expect(header).toHaveAttribute("aria-expanded", "true")
      await page.keyboard.press("a")
      await expect(header).toHaveAttribute("aria-expanded", "true")
      await page.keyboard.press(" ")
      await expect(header).toHaveAttribute("aria-expanded", "false")
    })
    await time("history-expand-epic", async () => {
      await page.getByRole("button", { name: /The compiler/ }).click()
      await expect(page.getByRole("list", { name: "The compiler" }).getByRole("link")).toHaveCount(50)
    })
    await time("history-next-page", async () => {
      await page.getByRole("button", { name: /^Show more/ }).click()
      await expect(page.getByRole("list", { name: "The compiler" }).getByRole("link")).toHaveCount(100)
    })
    await time("history-open-commit", async () => {
      await page.getByRole("list", { name: "The compiler" }).getByRole("link").first().click()
      await expect(page).toHaveURL(/#m\d+$/)
      await expect(page.locator(".mh-note-sections > div > .sui-label")).toHaveText(["Tried", "Evidence", "Folded", "Superseded"])
      await expect.poll(() => page.locator(".mh-note-list a[href^='https://github.com/smithersai/vibelang/commit/']").count()).toBeGreaterThan(0)
    })
    await time("history-amend-and-escape", async () => {
      await page.getByRole("button", { name: "Amend…" }).click()
      const dialog = page.getByRole("dialog", { name: "Amend", exact: true })
      await expect(dialog).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(dialog).toBeHidden()
    })
    const originalHash = new URL(page.url()).hash
    await time("history-amend-submit", async () => {
      await page.getByRole("button", { name: "Amend…" }).click()
      const dialog = page.getByRole("dialog", { name: "Amend", exact: true })
      await dialog.getByLabel("Task", { exact: true }).fill("Benchmark amendment")
      await dialog.getByRole("button", { name: "Amend", exact: true }).click()
      await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("planned")
      await expect(page.getByText("Benchmark amendment", { exact: true })).toBeVisible()
      expect(new URL(page.url()).hash).toBe(originalHash)
    })
    let insertedHash = ""
    await time("history-insert-before", async () => {
      await page.getByRole("button", { name: "Insert before…" }).click()
      const dialog = page.getByRole("dialog", { name: "Plan work", exact: true })
      await dialog.getByLabel("Commit", { exact: true }).fill("Benchmark insertion")
      await dialog.getByLabel("Task", { exact: true }).fill("Measure ordering")
      await dialog.getByRole("button", { name: "Plan work", exact: true }).click()
      await expect(page.getByRole("heading", { level: 1, name: "Benchmark insertion" })).toBeVisible()
      insertedHash = new URL(page.url()).hash
      expect(insertedHash).toMatch(/^#m\d+$/)
      expect(insertedHash).not.toBe(originalHash)
    })
    await page.getByRole("link", { name: "History", exact: true }).click()
    await expect(page.getByRole("list", { name: "The compiler", exact: true }).getByRole("link").first()).toHaveAttribute("href", insertedHash)
    await expect(page.getByRole("list", { name: "The compiler", exact: true }).getByRole("link").nth(1)).toHaveAttribute("href", originalHash)
    await time("history-filter-keystroke", async () => {
      await page.getByRole("searchbox", { name: "Filter commits" }).pressSequentially("compiler")
      await expect(page.getByRole("list", { name: "Matching commits" }).getByRole("link").first()).toBeVisible()
    })
    await page.getByRole("searchbox", { name: "Filter commits" }).fill("")
    await time("history-plan-new-epic", async () => {
      await page.getByRole("button", { name: "Plan work", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Plan work" })
      await dialog.getByLabel("Epic", { exact: true }).selectOption({ label: "New epic…" })
      await dialog.getByLabel("New epic", { exact: true }).fill("Benchmark epic")
      await expect(dialog.getByLabel("New epic", { exact: true })).toHaveValue("Benchmark epic")
      await dialog.getByLabel("Epic", { exact: true }).selectOption({ label: "The compiler" })
      await expect(dialog.getByLabel("New epic", { exact: true })).toHaveCount(0)
      await page.keyboard.press("Escape")
      await expect(dialog).toHaveCount(0)
    })
    await time("history-plan", async () => {
      await page.getByRole("button", { name: "Plan work", exact: true }).click()
      const dialog = page.getByRole("dialog", { name: "Plan work" })
      await expect(dialog.getByLabel("Commit", { exact: true })).toBeFocused()
      await dialog.getByLabel("Commit", { exact: true }).fill("Benchmark lifecycle")
      await dialog.getByLabel("Epic", { exact: true }).selectOption({ label: "The compiler" })
      await dialog.getByLabel("Task", { exact: true }).fill("Measure")
      await dialog.getByRole("button", { name: "Plan work", exact: true }).click()
      await expect(page.getByRole("heading", { level: 1, name: "Benchmark lifecycle" })).toBeVisible()
      await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("planned")
    })
    await time("history-start", async () => {
      await page.getByLabel("Lane", { exact: true }).fill("bench")
      await page.getByRole("button", { name: "Start", exact: true }).click()
      await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("working")
    })
    await time("history-add-note", async () => {
      await page.getByLabel("Section", { exact: true }).selectOption("tried")
      await page.getByLabel("Note", { exact: true }).fill("Measured.")
      await page.getByRole("button", { name: "Add note", exact: true }).click()
      await expect(page.locator(".mh-note-list li").filter({ hasText: "Measured." })).toHaveText("Measured. · Guest")
    })
    await time("history-approve", async () => {
      await page.getByRole("button", { name: "Approve", exact: true }).click()
      await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("approved")
    })
    await time("history-fold", async () => {
      await page.getByRole("link", { name: "History", exact: true }).click()
      await expect(page.getByRole("list", { name: "Planned" })).toContainText("Benchmark lifecycle")
      await page.getByRole("button", { name: "Fold", exact: true }).click()
      const planned = page.getByRole("list", { name: "Planned", exact: true })
      await expect(planned.getByRole("link")).toHaveCount(2)
      await expect.poll(() => planned.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href")))).toEqual([insertedHash, originalHash])
      await expect(planned.getByRole("link", { name: "Benchmark lifecycle", exact: true })).toHaveCount(0)
      await page.getByRole("searchbox", { name: "Filter commits" }).fill("Benchmark lifecycle")
      await page.getByRole("list", { name: "Matching commits" }).getByRole("link").click()
      await expect(page.locator(".mh-meta .sui-badge").first()).toHaveText("landed")
      await expect(page.locator(".mh-note-list a[href*='/commit/f01d']")).toHaveCount(1)
    })
    if (coverage) await coverage()
    await time("history-viewer-controls", async () => {
      await page.goto(`${baseURL}/history?agent=mock&role=viewer`)
      await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 30000 })
      await expect(page.getByRole("button", { name: "Plan work", exact: true })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Fold", exact: true })).toHaveCount(0)
    })
    if (coverage) await coverage()
    await time("history-return-visit", async () => {
      // No ?agent= now: the page keeps the mock mode the earlier visit stored.
      expect(await page.evaluate(() => localStorage.getItem("vibelang.agent"))).toBe("mock")
      await page.goto(`${baseURL}/history`)
      await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 30000 })
      await expect(page.getByText("Mock", { exact: true })).toBeVisible()
    })
    await time("history-no-choice", async () => {
      // Nothing stored and no query: the page asks /api/health, which this local build does not serve, and shows the mock.
      await page.evaluate(() => localStorage.removeItem("vibelang.agent"))
      await page.goto(`${baseURL}/history`)
      await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 30000 })
      await expect(page.getByText("Mock", { exact: true })).toBeVisible()
      expect(await page.evaluate(() => localStorage.getItem("vibelang.agent"))).toBeNull()
    })
  } finally {
    try { if (coverage) await coverage() } finally {
      await save("history-browser-actions", { origin: baseURL, timings }, ["One serial Chromium journey over the full committed history and real MockMythical durable flows. Bootstrap, scripted work and automation included; no percentile. Fold changes only the product mock, never a real repository. Viewer UI omits writes; live writes are benchmarked as actual workerd refusals. The last two steps reopen /history with no query: first the stored mock choice decides the mode, then, with nothing stored, the failed local /api/health check falls back to the mock."])
    }
  }
})

test("sandbox start, terminal, stop, retained restart, pane and viewer", async ({ page, baseURL }) => {
  test.skip(live, "Sandbox compute uses the product mock; trusted live identity and Container activation are separate gates.")
  const timings: { action: string; ms: number; passed: boolean }[] = []
  const coverage = await collectBrowserCoverage(page.context(), page, baseURL, "sandbox")
  const time = async (action: string, body: () => Promise<void>) => {
    const start = performance.now(); let passed = false
    try { await body(); passed = true } finally { timings.push({ action, ms: performance.now() - start, passed }) }
  }
  try {
    await page.goto(`${baseURL}/?agent=mock&role=contributor`)
    await page.getByRole("button", { name: "Ask the agent" }).click()
    await page.getByRole("dialog").getByRole("textbox").fill("hello")
    await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
    await expect(page.locator("[data-role='assistant'][data-done='true']")).toHaveCount(1)
    await time("sandbox-open-pane", async () => {
      await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
      await expect(page.getByRole("button", { name: "New sandbox" })).toBeVisible()
    })
    await time("sandbox-start", async () => {
      await page.getByRole("button", { name: "New sandbox" }).click()
      await expect(page.getByRole("status", { name: "Sandbox", exact: true })).toHaveText("Running")
    })
    const command = page.getByRole("textbox", { name: "Terminal command" })
    const output = page.getByLabel("Terminal output", { exact: true })
    await time("sandbox-terminal-write", async () => {
      await command.fill("echo saved > keep.txt")
      await command.press("Enter")
      await expect.poll(() => output.textContent()).toBe("$ echo saved > keep.txt\n\n")
      await expect(command).toBeEnabled()
    })
    await time("sandbox-stop", async () => {
      await page.getByRole("button", { name: "Stop", exact: true }).click()
      await expect(page.getByRole("status", { name: "Sandbox", exact: true })).toHaveText("Stopped")
      await expect(command).toBeDisabled()
    })
    await time("sandbox-restart", async () => {
      await page.getByRole("button", { name: "Start", exact: true }).click()
      await expect(page.getByRole("status", { name: "Sandbox", exact: true })).toHaveText("Running")
    })
    await time("sandbox-read-retained-bytes", async () => {
      await command.fill("cat keep.txt")
      await command.press("Enter")
      await expect.poll(() => output.textContent()).toBe("$ echo saved > keep.txt\n\n$ cat keep.txt\nsaved\n\n")
      await expect(command).toBeEnabled()
    })
    await time("sandbox-maximize", async () => {
      await page.getByRole("button", { name: "Maximize Sandboxes" }).click()
      await expect(page.getByRole("table", { name: "Minutes by role" }).getByRole("row")).toHaveCount(6)
    })
    await time("sandbox-minimize", async () => {
      await page.getByRole("button", { name: "Minimize Sandboxes" }).click()
      await expect(page.getByRole("table", { name: "Minutes by role" })).toBeHidden()
    })
    await page.getByRole("button", { name: "Maximize Sandboxes" }).click()
    await time("sandbox-escape", async () => {
      await page.keyboard.press("Escape")
      await expect(page.getByRole("table", { name: "Minutes by role" })).toBeHidden()
    })
    if (coverage) await coverage()
    await page.goto(`${baseURL}/?agent=mock`)
    await page.getByRole("button", { name: "Ask the agent" }).click()
    await page.getByRole("dialog").getByRole("textbox").fill("hello")
    await page.getByRole("dialog").getByRole("button", { name: "Send" }).click()
    await time("sandbox-viewer-controls", async () => {
      await page.getByRole("button", { name: "Sandboxes", exact: true }).click()
      await expect(page.getByText("Sign in to start a sandbox", { exact: true })).toBeVisible()
      await expect(page.getByRole("button", { name: "New sandbox" })).toHaveCount(0)
    })
  } finally {
    if (coverage) await coverage()
    await save("sandbox-browser-actions", { origin: baseURL, timings }, ["One serial real Chromium journey over product mock flows and supported terminal commands; exact retained terminal transcript checked across Stop/Start. No model/backend/real Container. Forced mock roles never grant live authority. Automation and scripted waits included; no percentile."])
  }
})

test("role views, People, grant confirmation, sign-out and participation", async ({ page, baseURL }) => {
  test.skip(live, "Product fixture identities; no production sign-in or account mutation.")
  const timings: { action: string; ms: number; passed: boolean }[] = []
  const coverage = await collectBrowserCoverage(page.context(), page, baseURL, "roles")
  const time = async (action: string, body: () => Promise<void>) => {
    const start = performance.now(); let passed = false
    try { await body(); passed = true } finally { timings.push({ action, ms: performance.now() - start, passed }) }
  }
  try {
    await page.goto(`${baseURL}/?agent=mock`)
    const picker = page.getByRole("combobox", { name: "Visit as" })
    for (const role of ["viewer", "new", "community", "contributor", "maintainer"]) {
      await time(`role-view-${role}`, async () => {
        await picker.selectOption(role)
        await expect(picker).toHaveValue(role)
        if (role === "viewer") await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
        else {
          await page.getByRole("button", { name: "Account", exact: true }).click()
          await page.getByRole("menuitem", { name: "People", exact: true }).click()
          await expect(page.getByRole("region", { name: "People", exact: true })).toBeVisible()
          if (role === "maintainer") await expect(page.getByRole("combobox", { name: "Role for rira", exact: true })).toHaveValue("contributor")
          else await expect(page.getByRole("combobox", { name: /^Role for/ })).toHaveCount(0)
          await page.getByRole("button", { name: "Close People", exact: true }).click()
        }
      })
    }
    await time("account-menu-keyboard", async () => {
      const account = page.getByRole("button", { name: "Account", exact: true })
      await account.focus()
      await account.press("Enter")
      await expect(page.getByRole("menuitem", { name: "People", exact: true })).toBeFocused()
      await page.keyboard.press("ArrowDown")
      await expect(page.getByRole("menuitem", { name: "Sign out", exact: true })).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(page.getByRole("menu", { name: "Account menu", exact: true })).toHaveCount(0)
      await expect(account).toBeFocused()
    })
    await page.getByRole("button", { name: "Account", exact: true }).click()
    await page.getByRole("menuitem", { name: "People", exact: true }).click()
    await time("promote-member", async () => {
      const target = page.getByRole("combobox", { name: "Role for joss", exact: true })
      await expect(target).toHaveValue("new")
      await target.selectOption("community")
      await page.getByRole("dialog", { name: "Promote joss to Community?", exact: true }).getByRole("button", { name: "Promote", exact: true }).click()
      await expect(target).toHaveValue("community")
    })
    const target = page.getByRole("combobox", { name: "Role for rira", exact: true })
    await time("cancel-role-change", async () => {
      await target.selectOption("maintainer")
      await page.getByRole("dialog", { name: "Promote rira to Maintainer?", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(target).toHaveValue("contributor")
    })
    await time("escape-role-dialog", async () => {
      await target.selectOption("maintainer")
      await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(page.getByRole("dialog", { name: "Promote rira to Maintainer?", exact: true })).toHaveCount(0)
      await expect(target).toHaveValue("contributor")
    })
    await time("demote-member", async () => {
      await target.selectOption("community")
      await page.getByRole("dialog", { name: "Demote rira to Community?", exact: true }).getByRole("button", { name: "Demote", exact: true }).click()
      await expect(target).toHaveValue("community")
    })
    await time("restore-member", async () => {
      await target.selectOption("contributor")
      await page.getByRole("dialog", { name: "Promote rira to Contributor?", exact: true }).getByRole("button", { name: "Promote", exact: true }).click()
      await expect(target).toHaveValue("contributor")
    })
    await page.getByRole("button", { name: "Close People", exact: true }).click()
    await time("sign-out", async () => {
      await page.getByRole("button", { name: "Account", exact: true }).click()
      await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
      await expect(picker).toHaveValue("viewer")
      await expect(page.getByRole("combobox", { name: /^Role for/ })).toHaveCount(0)
    })
    await time("mock-sign-in", async () => {
      await page.getByRole("button", { name: "Sign in", exact: true }).click()
      await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
      await expect(picker).toHaveValue("new")
    })
    await time("participation-promotes-community", async () => {
      await page.keyboard.press("Meta+k")
      const prompt = page.getByRole("dialog", { name: "Ask the agent", exact: true })
      await prompt.getByRole("textbox", { name: "Message", exact: true }).fill("How do I install it?")
      await prompt.getByRole("button", { name: "Send", exact: true }).click()
      await expect(page.getByText("You're now Community.", { exact: true })).toBeVisible()
      await expect(picker).toHaveValue("community")
      await expect(page.locator("[data-role='assistant'][data-done='true']")).toHaveCount(1)
      await expect(page.locator("[data-role='assistant']")).toContainText("create vibelang@latest")
    })
    if (coverage) await coverage()
    await page.goto(`${baseURL}/?agent=mock&sign-in=failed`)
    await expect(page.getByRole("alert")).toContainText("Sign-in failed.")
    await time("retry-mock-sign-in", async () => {
      await page.getByRole("button", { name: "Retry", exact: true }).click()
      await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible()
      await expect(page.getByRole("alert")).toHaveCount(0)
    })
  } finally {
    if (coverage) await coverage()
    await save("local-role-actions", { origin: baseURL, timings }, ["One serial native-browser journey over the real product fixture account/role flows. Each role visit includes selection, identity visibility and (for signed roles) opening/checking/closing People. Other actions include confirmation or cancellation and resulting state. Sign-in/retry use the explicit mock identity host; no GitHub login, production identity, account mutation or model. Scripted reply/automation delays included; one observation per action establishes no percentile."])
  }
})

test("wiki edit, Save, Propose, cancellation and reviewed agent draft", async ({ page, baseURL }) => {
  test.skip(live, "Product fixture repository; no production GitHub writes or model generation.")
  const timings: { action: string; ms: number; passed: boolean }[] = []
  const coverage = await collectBrowserCoverage(page.context(), page, baseURL, "wiki")
  const time = async (action: string, body: () => Promise<void>) => {
    const start = performance.now(); let passed = false
    try { await body(); passed = true } finally { timings.push({ action, ms: performance.now() - start, passed }) }
  }
  try {
    await page.goto(`${baseURL}/?agent=mock`)
    const picker = page.getByRole("combobox", { name: "Visit as" })
    const wiki = page.getByRole("region", { name: "Wiki", exact: true })
    await page.getByRole("button", { name: "Wiki", exact: true }).click()
    await wiki.getByRole("link", { name: "Roadmap", exact: true }).first().click()
    const editor = wiki.getByRole("textbox", { name: "Edit Roadmap", exact: true })
    await time("wiki-find-page", async () => {
      const find = wiki.getByRole("textbox", { name: "Find a page", exact: true })
      await find.fill("roadmap")
      await expect(wiki.getByRole("navigation", { name: "Wiki pages" }).getByRole("link", { name: "Roadmap", exact: true })).toBeVisible()
      await find.fill("no such page")
      await expect(wiki).toContainText('No pages match "no such page"')
      await find.fill("")
      await expect(wiki.getByRole("heading", { level: 1 }).first()).toContainText("Roadmap")
    })
    await picker.selectOption("maintainer")
    await time("wiki-save-unchanged", async () => {
      await wiki.getByRole("button", { name: "Edit", exact: true }).click()
      await expect(editor).toBeFocused()
      await wiki.getByRole("button", { name: "Save", exact: true }).click()
      await expect(wiki.getByRole("alert")).toHaveText("No changes.")
      await expect(editor).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(editor).toHaveCount(0)
    })
    for (const role of ["maintainer", "contributor"] as const) {
      await picker.selectOption(role)
      let source = ""
      await time(`wiki-edit-${role}`, async () => {
        await wiki.getByRole("button", { name: "Edit", exact: true }).click()
        await expect(editor).toBeFocused()
        source = await editor.inputValue()
        expect(source).toContain("# Roadmap")
      })
      await editor.fill(source + "\nBenchmark review.\n")
      await time(role === "maintainer" ? "wiki-save" : "wiki-propose", async () => {
        await wiki.getByRole("button", { name: role === "maintainer" ? "Save" : "Propose", exact: true }).click()
        await expect(editor).toHaveCount(0)
        await expect(wiki.getByRole("link", { name: "Review", exact: true })).toHaveAttribute("href", /\/pull\/[0-9]+$/)
        await expect(wiki.locator(".vl-wiki-content")).not.toContainText("Benchmark review.")
      })
      await wiki.getByRole("button", { name: "Edit", exact: true }).click()
      await expect(editor).toHaveValue(source)
      await editor.fill(source + "\nDiscard benchmark.\n")
      await time(`wiki-escape-${role}`, async () => {
        await page.keyboard.press("Escape")
        await expect(editor).toHaveCount(0)
        await expect(wiki).not.toContainText("Discard benchmark.")
      })
    }
    await wiki.getByRole("button", { name: "Edit", exact: true }).click()
    await time("wiki-role-change-closes-editor", async () => {
      await picker.selectOption("viewer")
      await expect(editor).toHaveCount(0)
      await expect(wiki.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
    })
    if (coverage) await coverage()
    await page.goto(`${baseURL}/?agent=mock&role=contributor`)
    await time("wiki-agent-draft-review", async () => {
      await page.getByRole("button", { name: "Ask the agent", exact: true }).click()
      const ask = page.getByRole("dialog", { name: "Ask the agent", exact: true })
      await ask.getByRole("textbox", { name: "Message", exact: true }).fill("Draft a wiki edit for the roadmap: benchmark reviewed draft")
      await ask.getByRole("button", { name: "Send", exact: true }).click()
      await page.getByRole("link", { name: "Review it", exact: true }).click()
      await expect(editor).toHaveValue(/benchmark reviewed draft/)
    })
    await time("wiki-agent-draft-propose", async () => {
      await wiki.getByRole("button", { name: "Propose", exact: true }).click()
      await expect(editor).toHaveCount(0)
      await expect(wiki.getByRole("link", { name: "Review", exact: true })).toBeVisible()
      await expect(wiki.locator(".vl-wiki-content")).not.toContainText("benchmark reviewed draft")
    })
  } finally {
    if (coverage) await coverage()
    await save("local-wiki-actions", { origin: baseURL, timings }, ["One serial native Chromium journey through real product fixture flows. Maintainer Save and contributor Propose each open a review and preserve repository Markdown; reopening checks the original source. Escape, role revocation and a scripted agent draft are checked. No real GitHub writes, OAuth or model. Scripted waits and automation included; one sample per action establishes no percentile."])
  }
})

test("issues list, commit dialog, comment, uncommit, keyboard and VIP proposal", async ({ page, baseURL }) => {
  test.skip(live, "Product fixture issues; no production GitHub writes or model generation.")
  const timings: { action: string; ms: number; passed: boolean }[] = []
  const coverage = await collectBrowserCoverage(page.context(), page, baseURL, "issues")
  const time = async (action: string, body: () => Promise<void>) => {
    const start = performance.now(); let passed = false
    try { await body(); passed = true } finally { timings.push({ action, ms: performance.now() - start, passed }) }
  }
  try {
    await page.goto(`${baseURL}/?agent=mock`)
    await page.getByRole("combobox", { name: "Visit as" }).selectOption("maintainer")
    await expect(page.locator(".vl-nav-role")).toHaveText("Maintainer")
    await time("issues-open", async () => {
      await page.getByRole("button", { name: "Issues", exact: true }).click()
      await expect(page.getByRole("heading", { name: "Issues", exact: true })).toBeVisible()
      await expect(page.getByRole("link", { name: "Case branches on tuples", exact: true })).toBeVisible()
    })
    await time("issues-list-keys", async () => {
      await page.getByRole("radio", { name: "All", exact: true }).focus()
      await page.keyboard.press("ArrowRight")
      await expect(page.getByRole("radio", { name: "Issues", exact: true })).toBeFocused()
      const first = page.locator(".sui-issues-link").first()
      await first.focus()
      await page.keyboard.press("j")
      await expect(page.locator(".sui-issues-link").nth(1)).toBeFocused()
      await page.keyboard.press("k")
      await expect(first).toBeFocused()
    })
    await page.getByRole("radio", { name: "All", exact: true }).click()
    await time("issues-search", async () => {
      const match = page.getByRole("link", { name: "Case branches on tuples", exact: true })
      const other = page.getByRole("link", { name: "Pattern matching in case", exact: true })
      await expect(other).toBeVisible()
      await page.getByRole("searchbox", { name: "Search issues", exact: true }).fill("tuples")
      await expect(match).toBeVisible()
      await expect(other).toHaveCount(0)
      await page.getByRole("searchbox", { name: "Search issues", exact: true }).fill("")
      await expect(other).toBeVisible()
    })
    await time("issue-open", async () => {
      await page.getByRole("link", { name: "Case branches on tuples", exact: true }).click()
      await expect(page.locator(".sui-item-conv-post")).toContainText("Today only literal values match.")
      await expect(page.getByRole("link", { name: "#38 Effect-native modules" }).first()).toBeVisible()
    })
    const commit = page.getByRole("button", { name: "Commit", exact: true })
    const dialog = page.getByRole("dialog", { name: "Commit #42 as a task" })
    await time("issue-commit-dialog-escape", async () => {
      await commit.click()
      await expect(dialog).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(dialog).not.toBeVisible()
      await expect(commit).toBeFocused()
    })
    await time("issue-commit", async () => {
      await commit.click()
      await dialog.getByRole("button", { name: "Commit", exact: true }).click()
      await expect(page.getByRole("button", { name: "Uncommit" })).toBeVisible()
      await expect(page.locator(".sui-item-conv-header")).toContainText("Task · Queued")
    })
    await time("issue-comment", async () => {
      const comment = page.getByRole("textbox", { name: "Comment", exact: true })
      await comment.fill("Benchmark comment on nested tuples.")
      await comment.press("ControlOrMeta+Enter")
      await expect(page.getByText("Benchmark comment on nested tuples.", { exact: true })).toBeVisible()
    })
    await time("issue-uncommit", async () => {
      await page.getByRole("button", { name: "Uncommit" }).click()
      await expect(commit).toBeVisible()
    })
    if (coverage) await coverage()
    await page.goto(`${baseURL}/?agent=mock&role=maintainer`)
    await expect(page.locator(".vl-nav-role")).toHaveText("Maintainer")
    await page.getByRole("button", { name: "Issues", exact: true }).click()
    await time("vip-agent-draft", async () => {
      await page.getByRole("radio", { name: "VIPs", exact: true }).click()
      await page.getByRole("button", { name: "Propose a VIP", exact: true }).click()
      await page.getByRole("textbox", { name: "Title", exact: true }).fill("Benchmark tuple patterns")
      await page.getByRole("button", { name: "Draft with agent", exact: true }).click()
      await expect(page.getByRole("textbox", { name: "Summary", exact: true })).toHaveValue("Bind the elements of a tuple in one pattern.")
    })
    await time("vip-steps-and-submit", async () => {
      await page.getByRole("button", { name: "Continue" }).click()
      await expect(page.getByRole("textbox", { name: "Example", exact: true })).toHaveValue("const pair = [1, 2]")
      await page.getByRole("button", { name: "Continue" }).click()
      await expect(page.getByRole("textbox", { name: "Prior art", exact: true })).toHaveValue(/Rust/)
      await page.getByRole("button", { name: "Continue" }).click()
      await expect(page.getByText("Bind the elements of a tuple in one pattern.", { exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Submit VIP", exact: true }).click()
      await expect(page.locator(".sui-item-conv-header")).toContainText("VIP · In review")
      await expect(page.getByRole("link", { name: "Review change" })).toHaveAttribute("href", /github.com\/smithersai\/vibelang\/pull\//)
    })
    await time("specification-revise-and-review", async () => {
      await page.getByRole("link", { name: "‹ Issues" }).first().click()
      await page.getByRole("button", { name: "Specification", exact: true }).click()
      await expect(page.getByRole("status", { name: "Specification gate" })).toBeVisible()
      const table = page.getByRole("table", { name: "Specification reviews" })
      await expect(table.getByRole("row")).toHaveCount(5)
      const title = await page.getByText(/^Revision \d+$/).first().textContent()
      const revision = Number(title!.replace("Revision ", ""))
      await page.getByRole("textbox", { name: "Specification text" }).fill("Benchmark revision of the specification.")
      await page.getByRole("button", { name: "Save revision" }).click()
      await expect(page.getByText(`Revision ${revision + 1}`, { exact: true })).toBeVisible()
      const row = table.getByRole("row", { name: /Codex Astra/ })
      await row.getByRole("button", { name: "Request review" }).click()
      await expect(row.getByRole("cell").nth(3)).toHaveText(String(revision + 1))
    })
    await time("issues-home", async () => {
      await page.getByRole("button", { name: "Home", exact: true }).click()
      await expect(page.getByRole("heading", { name: "VibeLang", exact: true })).toBeVisible()
      await expect(page.getByRole("region", { name: "Issues pane" })).not.toBeVisible()
    })
  } finally {
    if (coverage) await coverage()
    await save("local-issues-actions", { origin: baseURL, timings }, ["One serial native Chromium journey through the product fixture issue flows as a maintainer: list keys, an issue's post and links, the commit dialog's Escape and commit, a comment, uncommit, an agent-drafted VIP through its steps to submission, and Home. Each step checks the resulting screen. No real GitHub writes, OAuth or model. Scripted waits and automation included; one sample per action establishes no percentile."])
  }
})

test("tour controls, resize, Actions panel arms, slash keys, Escape arms and wiki links", async ({ page, baseURL }) => {
  test.skip(live, "Product mock flows; production model work is separately opt in.")
  const timings: { action: string; ms: number; passed: boolean }[] = []
  const coverage = await collectBrowserCoverage(page.context(), page, baseURL, "arms")
  const time = async (action: string, body: () => Promise<void>) => {
    const start = performance.now(); let passed = false
    try { await body(); passed = true } finally { timings.push({ action, ms: performance.now() - start, passed }) }
  }
  const bar = page.getByRole("region", { name: "Walkthrough" })
  try {
    // A returning person, until the last step clears storage to measure a first visit.
    await page.addInitScript(() => localStorage.setItem("vibelang:tour-sound", "off"))
    await page.goto(`${baseURL}/?agent=mock&role=contributor`)
    await time("tour-start", async () => {
      await page.getByRole("button", { name: "Learn more", exact: true }).click()
      await expect(bar).toHaveAttribute("data-step", "1", { timeout: 15000 })
    })
    await time("tour-tab-focus", async () => {
      await page.keyboard.press("Tab")
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeFocused()
      await page.keyboard.press("Shift+Tab")
      await expect(page.getByRole("button", { name: "Exit", exact: true })).toBeFocused()
    })
    await time("tour-resize", async () => {
      await page.setViewportSize({ width: 1100, height: 760 })
      await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")))
      await expect(bar).toHaveAttribute("data-step", "1")
      await page.setViewportSize({ width: 1280, height: 800 })
    })
    await time("tour-sound-on", async () => {
      await page.getByRole("button", { name: "Sound on", exact: true }).click()
      await expect(page.getByRole("button", { name: "Sound off", exact: true })).toBeVisible()
      await expect.poll(() => page.evaluate(() => localStorage.getItem("vibelang:tour-sound"))).toBe("on")
      await page.getByRole("button", { name: "Sound off", exact: true }).click()
      await expect(page.getByRole("button", { name: "Sound on", exact: true })).toBeVisible()
    })
    await time("tour-skip-back", async () => {
      await page.getByRole("button", { name: "Skip", exact: true }).click()
      await expect(bar).toHaveAttribute("data-step", "2", { timeout: 15000 })
      await page.getByRole("button", { name: "Back", exact: true }).click()
      await expect(bar).toHaveAttribute("data-step", "1", { timeout: 15000 })
    })
    await time("tour-exit", async () => {
      await page.getByRole("button", { name: "Exit", exact: true }).click()
      await expect(bar).toHaveCount(0)
      await expect(page.locator("#vl-prompt")).toBeFocused()
    })
    await time("escape-nothing-open", async () => {
      const surface = await page.locator(".vl-app").getAttribute("data-surface")
      await page.keyboard.press("Escape")
      await expect(page.locator(".vl-app")).toHaveAttribute("data-surface", surface ?? "")
      await expect(page.getByRole("dialog")).toHaveCount(0)
    })
    const composer = page.locator('form[data-docked="true"]')
    const input = composer.getByRole("textbox", { name: "Message", exact: true })
    await input.fill("Hello")
    await input.press("Enter")
    await expect(page.getByRole("button", { name: "Expand Actions", exact: true })).toBeVisible()
    const pane = page.getByRole("region", { name: "Actions", exact: true })
    await time("actions-run-step", async () => {
      await page.getByRole("button", { name: "Expand Actions", exact: true }).click()
      await pane.getByRole("button", { name: "Tour", exact: true }).click()
      await pane.getByRole("button", { name: "Run", exact: true }).click()
      await page.getByRole("button", { name: /Open Tour run/ }).first().click()
      await expect(pane).toHaveAttribute("data-maximized", "true")
      const step = pane.getByRole("list", { name: "Steps" }).getByRole("button").first()
      await expect(step).toBeVisible({ timeout: 15000 })
      await step.click()
      await expect(pane.getByLabel("Logs", { exact: true })).toBeVisible()
      await pane.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(pane.getByText("Cancelled", { exact: true }).first()).toBeVisible()
    })
    await time("actions-input", async () => {
      await pane.getByRole("button", { name: "‹ Tour", exact: true }).click()
      await pane.getByRole("button", { name: "Post", exact: true }).click()
      const field = pane.getByRole("textbox", { name: "Action input", exact: true })
      await field.fill("Benchmark input")
      await expect(field).toHaveValue("Benchmark input")
    })
    await time("actions-maximize-button", async () => {
      await page.keyboard.press("Escape")
      await expect(pane).toHaveAttribute("data-maximized", "false")
      await pane.getByRole("button", { name: "Maximize Actions", exact: true }).click()
      await expect(pane).toHaveAttribute("data-maximized", "true")
      await page.keyboard.press("Escape")
      await expect(pane).toHaveAttribute("data-maximized", "false")
      await pane.getByRole("button", { name: "Collapse Actions", exact: true }).click()
      await expect(page.getByRole("button", { name: "Expand Actions", exact: true })).toBeVisible()
    })
    await time("slash-arrows-escape", async () => {
      await input.fill("/")
      const menu = composer.getByRole("listbox", { name: "Commands", exact: true })
      await expect(menu).toBeVisible()
      await input.press("ArrowDown")
      await input.press("ArrowUp")
      await expect(menu.getByRole("option").first()).toBeVisible()
      await input.press("Escape")
      await expect(menu).toHaveCount(0)
      await input.fill("")
    })
    await time("issues-escape", async () => {
      await page.getByRole("button", { name: "Issues", exact: true }).click()
      await expect(page.getByRole("region", { name: "Issues pane" })).toBeVisible()
      await page.getByRole("heading", { name: "Issues", exact: true }).click()
      await page.keyboard.press("Escape")
      await expect(page.getByRole("region", { name: "Issues pane" })).not.toBeVisible()
    })
    const wiki = page.getByRole("region", { name: "Wiki", exact: true })
    await time("wiki-link-and-back", async () => {
      await page.getByRole("button", { name: "Wiki", exact: true }).click()
      const link = wiki.locator('.vl-wiki-content a[href^="/wiki/"]').first()
      const href = await link.getAttribute("href")
      expect(href).toMatch(/^\/wiki\//)
      const before = await page.evaluate(() => location.pathname)
      await link.click()
      await expect.poll(() => page.evaluate(() => location.pathname)).toBe(href)
      await page.goBack()
      await expect.poll(() => page.evaluate(() => location.pathname)).toBe(before)
      await expect(wiki).toBeVisible()
    })
    await time("command-k-mock-switch", async () => {
      await page.keyboard.press("ControlOrMeta+k")
      const prompt = page.getByRole("dialog", { name: "Ask the agent" }).getByRole("textbox", { name: "Message" })
      await expect(prompt).toBeFocused()
      await prompt.fill("/mock")
      await Promise.all([page.waitForEvent("load"), prompt.press("Enter")])
      expect(new URL(page.url()).searchParams.get("agent")).toBe("mock")
      await expect(page.getByRole("link", { name: "Mock mode: switch to live", exact: true })).toBeVisible()
      await expect(page.getByRole("dialog", { name: "Ask the agent" })).toHaveCount(0)
    })
    await page.evaluate(() => { localStorage.clear(); sessionStorage.setItem("bench:first-visit", "yes") })
    await time("first-visit-auto-tour", async () => {
      await page.goto(`${baseURL}/?agent=mock`)
      await expect(bar).toHaveAttribute("data-step", "1", { timeout: 15000 })
      await page.getByRole("button", { name: "Exit", exact: true }).click()
      await expect(bar).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => localStorage.getItem("vibelang:toured"))).toBe("yes")
    })
  } finally {
    if (coverage) await coverage()
    await save("local-arms-actions", { origin: baseURL, timings }, ["One serial native Chromium journey through product mock flows: tour focus, resize and orientation, sound, Skip and Back, Exit, Escape with nothing open, the Actions panel's Maximize, input, a run's step and Escape, slash-menu arrows and Escape, Escape on Issues, an in-content wiki link with browser Back, ⌘K's /mock reloading the page in mock mode, and a first visit whose tour starts on its own. Each step checks the resulting screen. No network, OAuth or model. Scripted waits and automation included; one sample per action establishes no percentile."])
  }
})
