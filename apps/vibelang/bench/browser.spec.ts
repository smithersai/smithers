// Stays .ts: Playwright collects test files by JS/TS extension only; browser callbacks need its DOM host.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test, expect, type BrowserContext, type Page } from "@playwright/test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { cpus, hostname, platform, release } from "node:os"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
const live = process.env.BENCH_LIVE === "1"

async function save(name: string, measurements: unknown, limitations: string[]) {
  const timestamp = new Date().toISOString()
  const revision = (await promisify(execFile)("jj", ["log", "--no-graph", "-r", "@", "-T", "commit_id"], { timeout: 30000 })).stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Benchmark source revision is unavailable")
  const versions: Record<string, string> = {}
  for (const name of ["@playwright/test", "vibelang", "effect", "vitest"]) versions[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, "utf8")).version
  await mkdir("bench/results", { recursive: true })
  await writeFile(`bench/results/${timestamp.replaceAll(":", "-")}-${name}.json`, JSON.stringify({
    schema: 1, instrumented: process.env.BENCH_COVERAGE === "1", name, timestamp, localTime: new Date().toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    machine: { hostname: hostname(), platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    runtime: process.versions, versions, revision,
    deployment: { revision: live ? null : revision, identityMethod: live ? "Production does not expose its revision; unknown." : "Local build from this workspace revision." },
    method: "Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed.",
    limitations, measurements,
  }, null, 2) + "\n", { flag: "wx" })
}

async function collectBrowserCoverage(context: BrowserContext, page: Page, baseURL: string | undefined, name: string) {
  const directory = process.env.NODE_V8_COVERAGE
  if (!directory || live) return undefined
  const session = await context.newCDPSession(page)
  await session.send("Profiler.enable")
  await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true })
  return async () => {
    const raw = await session.send("Profiler.takePreciseCoverage")
    const result = raw.result.filter(entry => entry.url.startsWith(`${baseURL}/assets/`)).map(entry => ({ ...entry, url: pathToFileURL(resolve("dist", new URL(entry.url).pathname.slice(1))).href }))
    await mkdir(directory, { recursive: true })
    await writeFile(resolve(directory, `browser-${name}-${Date.now()}.json`), JSON.stringify({ result }), { flag: "wx" })
  }
}

test("first render, Command-K and per-keystroke browser latency", async ({ browser, baseURL }) => {
  const samples = []
  for (let run = 0; run < 3; run++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" })
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
    live ? "Default production backend selection; UI-only navigation and keys make no model call. Fresh context, shared browser/OS caches and automation overhead; no forced cold cache." : "Product mock mode, fresh browser context, shared browser/OS caches and automation overhead; no forced cold cache.",
  ])
})

test("post acceptance, first event, first answer delta, settlement, fresh/warm API", async ({ baseURL }) => {
  test.skip(!live, "Production inference is opt in through pnpm bench:live.")
  const samples: Record<string, unknown>[] = []
  try {
    const health = await fetch(`${baseURL}/api/health`)
    expect(await health.json()).toEqual({ ok: true, agent: "live" })
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
    await time("home-expand-minimize", async () => {
      await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
      await expect(page.getByRole("heading", { name: "VibeLang", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Minimize the VibeLang home page" }).click()
      await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
    })
    await page.getByRole("button", { name: "Expand the VibeLang home page" }).click()
    await time("learn-more-open-docs", async () => {
      await page.getByRole("button", { name: "Learn more", exact: true }).click()
      await expect(page.getByRole("button", { name: "Esc", exact: true })).toBeVisible()
      await expect(page.locator("iframe[title='VibeLang docs']")).toHaveAttribute("src", "https://vibelang.sh/")
    })
    await expect(page.getByRole("region", { name: "Docs", exact: true })).toHaveAttribute("data-maximized", "true")
    await expect(page.getByRole("region", { name: "Current stop" })).toContainText("VibeLang is Effect")
    await time("escape-tour", async () => {
      await page.keyboard.press("Escape")
      await expect(page.getByRole("button", { name: "Esc", exact: true })).toBeHidden()
      await expect(page.locator("[data-role='assistant'][data-in-reply-to=''][data-done='true']")).toHaveCount(1)
    })
    await expect(page.getByRole("region", { name: "Docs", exact: true })).toHaveAttribute("data-maximized", "false")
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused()
    await time("docs-maximize", async () => {
      await page.getByRole("button", { name: "Maximize the docs" }).click()
      await expect(page.getByRole("region", { name: "Docs", exact: true })).toHaveAttribute("data-maximized", "true")
    })
    await time("docs-minimize", async () => {
      await page.getByRole("button", { name: "Minimize the docs" }).click()
      await expect(page.getByRole("region", { name: "Docs", exact: true })).toHaveAttribute("data-maximized", "false")
    })
    await page.getByRole("button", { name: "Maximize the docs" }).click()
    await time("escape-docs", async () => {
      await page.keyboard.press("Escape")
      await expect(page.getByRole("region", { name: "Docs", exact: true })).toHaveAttribute("data-maximized", "false")
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
    await time("history-viewer-controls", async () => {
      await page.goto(`${baseURL}/history?agent=mock&role=viewer`)
      await expect(page.getByRole("button", { name: /The compiler/ })).toBeVisible({ timeout: 30000 })
      await expect(page.getByRole("button", { name: "Plan work", exact: true })).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Fold", exact: true })).toHaveCount(0)
    })
  } finally {
    try { if (coverage) await coverage() } finally {
      await save("history-browser-actions", { origin: baseURL, timings }, ["One serial Chromium journey over the full committed history and real MockMythical durable flows. Bootstrap, scripted work and automation included; no percentile. Fold changes only the product mock, never a real repository. Viewer UI omits writes; live writes are benchmarked as actual workerd refusals."])
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
