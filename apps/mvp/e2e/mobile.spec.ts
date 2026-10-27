import { expect, request as apiRequests, type Page, type TestInfo, type Locator, type Request } from "@playwright/test"
import { expectServerError, strictTest as base } from "./watch"
import { writeFile } from "node:fs/promises"
import { digestSync } from "@smthrs/crypto"
import { renderSource, SOURCE_PATH } from "../src/features/flows-ui/source"
import { recordActions, writeManifest } from "./fixtures"
import { desktopBaseline } from "./mobile-baseline"
import { openComposer } from "./composer"
import { serveFramedPage } from "./framed-page"
import { shapeRows } from "./shape"
import { redactRequestErrors } from "./redact"
import { baseURL, requires, scriptedAgent, target, writeHeaders, me, stackRepository, syncedRepository, ownPlace, signedOut, sessionFiles } from "./target"

// Real pages and services. Persist a structured audit even when several checks fail,
// so the first run is the red receipt for each subsequent layout change.
const test = base.extend<{ recording: void; mobileViewport: { width: number; height: number }; todos: Array<{ repository: string; title: string }> }>({
  todos: [async ({ request }, use) => {
    const todos: Array<{ repository: string; title: string }> = []
    try {
      await use(todos)
    } finally {
      // Fixture teardown has its own budget even when the test times out in
      // commit, list hydration, navigation or the layout audit.
      for (const { repository, title } of todos) {
        type Todo = { title: string; number: number; state: string; run_id: string | null }
        const path = `/api/shapes/todos?repo=${encodeURIComponent(repository)}`
        let todo: Todo | undefined
        await expect.poll(async () => {
          todo = (await shapeRows<Todo>(request, path)).find((row) => row.title === title)
          return Number(todo?.number)
        }, { timeout: 30_000, message: "recover the committed TODO even if its browser row never rendered" }).toBeGreaterThan(0)
        const dropped = await request.post(`/api/repos/${repository}/stack`, {
          headers: writeHeaders(), data: { opId: crypto.randomUUID(), op: "drop", number: Number(todo!.number) },
        })
        expect(dropped.ok(), "cleanup must drop the real TODO and request its run cancellation").toBe(true)
        await expect.poll(async () => {
          todo = (await shapeRows<Todo>(request, path)).find((row) => row.title === title)
          return todo?.state
        }, { timeout: 30_000 }).toBe("dropped")
        if (todo!.run_id !== null) await expect.poll(async () => {
          const run = await request.get(`/api/remote-runs/${encodeURIComponent(todo!.run_id!)}?limit=1`)
          if (!run.ok()) return `HTTP ${run.status()}`
          const body = await run.json() as { run: { status: string } }
          return body.run.status
        }, { timeout: 30_000, message: "a drop receipt is not proof the TODO's run stopped" }).toMatch(/^(cancelled|completed|failed)$/)
      }
    }
  }, { timeout: 100_000 }],
  mobileViewport: [{ width: 1280, height: 800 }, { option: true }],
  viewport: async ({ mobileViewport }, use) => use(mobileViewport),
  contextOptions: async ({ mobileViewport }, use, info) => {
    await use({ recordVideo: { dir: info.outputPath("videos"), size: mobileViewport } })
  },
  recording: [async ({ page }, use, info) => {
    const startedAt = Date.now()
    const errors: string[] = []
    const docsReads: Array<{ status: number; code?: string; reason?: string }> = []
    const reads: Array<Promise<void>> = []
    const shapes: Array<{ shape: string; status: number; rows?: number; complete?: boolean }> = []
    // A response event only means headers arrived. Electric may still be streaming
    // its body when navigation abandons the page; reading it here can pin teardown.
    // Inspect completed requests only, whose bodies can no longer wait on a stream.
    const recordResponse = async (request: Request) => {
      const response = await request.response()
      if (response === null) return
      const url = new URL(response.url())
      if (url.pathname.startsWith("/api/shapes/") && url.searchParams.get("live") !== "true") {
        const body = await response.json().catch(() => undefined) as Array<{ headers?: { operation?: string; control?: string } }> | undefined
        shapes.push({ shape: url.pathname, status: response.status(), ...(Array.isArray(body) ? {
          rows: body.filter((message) => message.headers?.operation !== undefined).length,
          complete: body.some((message) => message.headers?.control === "up-to-date"),
        } : {}) })
      }
      if (!new URL(response.url()).pathname.startsWith("/api/repos/smithersai/vibelang/docs")) return
      const receipt: { status: number; code?: string; reason?: string } = { status: response.status() }
      if (response.status() >= 400) {
        const body = await response.json().catch(() => ({})) as { code?: string; reason?: string }
        receipt.code = body.code
        receipt.reason = body.reason
      }
      docsReads.push(receipt)
    }
    const onFinished = (request: Request) => { reads.push(recordResponse(request)) }
    page.on("requestfinished", onFinished)
    page.on("pageerror", (error) => errors.push(error.message))
    await recordActions(page, info)
    await use()
    page.off("requestfinished", onFinished)
    if (info.status === "skipped") return
    await Promise.all(reads)
    await writeFile(info.outputPath("shape-reads.json"), JSON.stringify(shapes, null, 2))
    await info.attach("shape-reads", { path: info.outputPath("shape-reads.json"), contentType: "application/json" })
    await writeFile(info.outputPath("docs-reads.json"), JSON.stringify(docsReads, null, 2))
    await info.attach("docs-reads", { path: info.outputPath("docs-reads.json"), contentType: "application/json" })
    await writeFile(info.outputPath("page-errors.json"), JSON.stringify(errors, null, 2))
    const name = info.titlePath.slice(1).join("-").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 150)
    // Playwright moves its temporary recording beside the manifest during teardown.
    await writeManifest(info, "flow.json", startedAt, [{ name: "", video: "video.webm", openedAt: 0 }], { test: name, flow: name })
  }, { auto: true }],
})
test.use({ video: "on", screenshot: "only-on-failure", colorScheme: "light" })

type Finding = { element: string; problem: string }
const audit = async (page: Page, info: TestInfo, name = "screen", scope?: Locator) => {
  await page.evaluate(() => document.fonts.ready)
  const findings: Finding[] = []
  const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }))
  if (overflow.scroll > overflow.width) findings.push({ element: "document", problem: `horizontal scroll ${overflow.scroll} > ${overflow.width}` })
  const controls = (scope ?? page).locator('a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="tab"], [contenteditable="true"]')
  for (const control of await controls.all()) {
    if (!await control.isVisible()) continue
    // Long pages and scrollable panels are legitimate. Bring each target into view,
    // then verify it is reachable, rather than requiring the whole page above the fold.
    const issues = await control.evaluate((element) => {
      // Scroll and measure in one browser turn: a live list may replace this
      // control between separate scroll and measurement calls.
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })
      // Scrolling to the latest message legitimately hides its jump button.
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return []
      const rect = element.getBoundingClientRect()
      const name = `${element.tagName.toLowerCase()}.${element.className} ${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 80) ?? ""}`
      const errors: Finding[] = []
      if (innerWidth <= 960 && (rect.width < 32 || rect.height < 32)) errors.push({ element: name, problem: `tap target ${rect.width.toFixed(1)}×${rect.height.toFixed(1)}` })
      if (rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight) errors.push({ element: name, problem: `outside viewport ${JSON.stringify(rect.toJSON())}` })
      // An inline link can wrap: its bounding-box center may be empty space
      // between fragments. Check every actual fragment, not that empty space.
      for (const fragment of element.getClientRects()) {
        const insetX = Math.min(4, fragment.width / 4)
        const insetY = Math.min(4, fragment.height / 4)
        const points = [
          [fragment.x + fragment.width / 2, fragment.y + fragment.height / 2],
          [fragment.left + insetX, fragment.top + fragment.height / 2],
          [fragment.right - insetX, fragment.top + fragment.height / 2],
          [fragment.left + fragment.width / 2, fragment.top + insetY],
          [fragment.left + fragment.width / 2, fragment.bottom - insetY],
        ]
        for (const [x, y] of points) {
          const top = document.elementFromPoint(x!, y!)
          if (top !== element && !element.contains(top)) {
            errors.push({ element: name, problem: `covered by ${top?.tagName}.${top?.className}` })
            break
          }
        }
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent)
          const box = parent.getBoundingClientRect()
          const left = box.left + parent.clientLeft
          const top = box.top + parent.clientTop
          const clips = (overflow: string) => ["hidden", "clip", "auto", "scroll"].includes(overflow)
          if ((clips(style.overflowX) && (fragment.left < left - 1 || fragment.right > left + parent.clientWidth + 1)) ||
              (clips(style.overflowY) && (fragment.top < top - 1 || fragment.bottom > top + parent.clientHeight + 1))) {
            errors.push({ element: name, problem: `clipped by ${parent.tagName}.${parent.className}` })
          }
        }
      }
      return errors
    })
    findings.push(...issues)
  }
  findings.push(...await page.evaluate(() => {
    const errors: Finding[] = []
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      if (!(element instanceof HTMLElement) || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !element.textContent?.trim()) continue
      const style = getComputedStyle(element)
      // Accessibility-only labels are intentionally visually clipped, not visible prose.
      if (style.clipPath === "inset(50%)" || style.clip === "rect(0px, 0px, 0px, 0px)") continue
      // Visible overflow (including an outside badge) is not clipping.
      // Source viewers intentionally scroll; hidden/clip overflow loses text.
      if (element.scrollWidth > element.clientWidth + 1 && ["hidden", "clip"].includes(style.overflowX)) {
        errors.push({ element: `${element.tagName.toLowerCase()}.${element.className} ${element.textContent.trim().slice(0, 80)}`, problem: `text clipped ${element.scrollWidth} > ${element.clientWidth}` })
      }
      if (element.scrollHeight > element.clientHeight + 1 && ["hidden", "clip"].includes(style.overflowY)) {
        errors.push({ element: `${element.tagName.toLowerCase()}.${element.className}`, problem: `text clipped vertically ${element.scrollHeight} > ${element.clientHeight}` })
      }
      // Check actual text fragments against clipping ancestors. A scrollable
      // ancestor makes its offscreen text reachable and ends that axis's check.
      for (const child of element.childNodes) {
        if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(child)
        for (const fragment of range.getClientRects()) {
          let checkX = true
          let checkY = true
          for (let parent: HTMLElement | null = element; parent && (checkX || checkY); parent = parent.parentElement) {
            const parentStyle = getComputedStyle(parent)
            if (["auto", "scroll"].includes(parentStyle.overflowX)) checkX = false
            if (["auto", "scroll"].includes(parentStyle.overflowY)) checkY = false
            const box = parent.getBoundingClientRect()
            const left = box.left + parent.clientLeft
            const top = box.top + parent.clientTop
            if ((checkX && ["hidden", "clip"].includes(parentStyle.overflowX) && (fragment.left < left - 1 || fragment.right > left + parent.clientWidth + 1)) ||
                (checkY && ["hidden", "clip"].includes(parentStyle.overflowY) && (fragment.top < top - 1 || fragment.bottom > top + parent.clientHeight + 1))) {
              errors.push({ element: `${element.tagName.toLowerCase()}.${element.className}`, problem: `text clipped by ${parent.tagName}.${parent.className}` })
              break
            }
          }
        }
      }
    }
    return errors
  }))
  await page.evaluate(() => window.scrollTo(0, 0))
  const receipt = info.outputPath(`${name}.json`)
  await writeFile(receipt, JSON.stringify({ route: page.url(), viewport: page.viewportSize(), findings }, null, 2))
  await info.attach(`layout-audit-${name}`, { path: receipt, contentType: "application/json" })
  if (page.viewportSize()?.width === 1280) await desktopBaseline(page, info, name)
  else await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: "disabled" })
  expect.soft(findings, `${page.url()} at ${JSON.stringify(page.viewportSize())}`).toEqual([])
}

const screens = [
  { name: "landing", path: "/", ready: "main" },
  { name: "home", path: "/app", ready: 'main[aria-label="App"]' },
  { name: "repository", path: "/octocat/Spoon-Knife", ready: 'header[aria-label="Repository"]' },
  { name: "curated-home", path: "/smithersai/vibelang", ready: '[data-slot="repository-home"]' },
  { name: "branch", path: "/octocat/Spoon-Knife/tree/test-branch", ready: 'nav[aria-label="Branch"]' },
  { name: "files", path: "/octocat/Spoon-Knife/blob/main/README.md", ready: 'article[aria-label="README.md"]' },
  { name: "raw-unavailable", path: "/octocat/Spoon-Knife/raw/mobile-missing-ref/missing.txt", ready: 'main[aria-label="Repository"]' },
  { name: "file-tabs", path: "/octocat/Spoon-Knife/blob/main/index.html", ready: 'article[aria-label="index.html"]' },
  { name: "issues", path: "/smithersai/smithers/issues", ready: "main" },
  { name: "new-issue", path: "/smithersai/smithers/issues/new", ready: "main" },
  { name: "issue-unavailable", path: "/smithersai/smithers/issues/2147483647", ready: "main" },
  { name: "pull-unavailable", path: "/smithersai/smithers/pull/2147483647", ready: "main" },
  ...["commits", "checks", "files"].map((tab) => ({ name: `pull-${tab}-unavailable`, path: `/smithersai/smithers/pull/2147483647/${tab}`, ready: "main" })),
  { name: "pulls", path: "/smithersai/smithers/pulls", ready: "main" },
  { name: "stack", path: "/octocat/Spoon-Knife/stack", ready: 'main[aria-label="Stack"]' },
  { name: "actions", path: "/smithersai/smithers/actions", ready: 'main[aria-label="Runs"]' },
  { name: "action-run", path: "/smithersai/smithers/actions/runs/mobile-missing-run", ready: 'main[aria-label="Run"]' },
  { name: "run-unavailable", path: "/app/runs/mobile-missing-run", ready: 'main[aria-label="Run"]' },
  { name: "view-unavailable", path: "/app/views/00000000-0000-4000-8000-000000000000", ready: 'main[aria-label="View"]' },
  { name: "draft-unavailable", path: "/app/flows/drafts/00000000-0000-4000-8000-000000000000", ready: 'main[aria-label="Draft"]' },
  { name: "code-unavailable", path: "/app/flows/code/mobile-missing-flow", ready: 'main[aria-label="Code"]' },
  { name: "todo-unavailable", path: "/smithersai/smithers/stack/2147483647", ready: 'main[aria-label="TODO"]' },
  { name: "plugin-path-unavailable", path: "/app/queue/mobile-missing-item", ready: "body" },
  { name: "runs", path: "/app/runs", ready: 'main[aria-label="Runs"]' },
  { name: "flows", path: "/app/flows", ready: 'main[aria-label="Flows"]' },
  { name: "new-flow", path: "/app/flows/new", ready: "main" },
  { name: "conversations", path: "/app/conversations", ready: 'main[aria-label="Conversations"]' },
  { name: "secrets", path: "/smithersai/smithers/settings/secrets", ready: 'main[aria-label="Secrets"]' },
  { name: "repo-settings", path: "/smithersai/smithers/settings", ready: 'main[aria-label="Settings"]' },
  { name: "settings", path: "/app/settings", ready: 'main[aria-label="Settings"]' },
  { name: "docs", path: "/smithersai/vibelang/docs", ready: '.docs-page-index' },
  { name: "doc-page", path: "/smithersai/vibelang/docs/error-management/018-retrying.md", ready: '[aria-label="Docs"]' },
  { name: "queue", path: "/app/queue", ready: "main" },
  { name: "terminal", path: "/octocat/Spoon-Knife/tree/test-branch?terminal=me", ready: ".terminal-panel" },
] as const

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }]) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ mobileViewport: viewport })
    for (const signedIn of [false, true]) {
      test.describe(signedIn ? "signed in" : "signed out", () => {
        if (!signedIn) test.use(signedOut)
        test.beforeEach(async ({ context }) => {
          if (!signedIn && target === "deployment") await context.clearCookies()
          if (!signedIn && target === "local") {
            const secure = baseURL.startsWith("https:")
            await context.addCookies([{ name: `${secure ? "__Host-" : ""}smithers_dev_signed_out`, value: "1", url: baseURL, secure }])
          }
          // The farm's static page can be ready before its Worker. Wait for
          // the session boundary before opening the page under test.
          await expect.poll(async () => {
            const session = await context.request.get("/api/auth/session").catch(() => undefined)
            if (session === undefined) return { status: 0 }
            return { status: session.status(), ...(session.ok() ? await session.json() : {}) }
          }, { timeout: 30_000 }).toMatchObject({ status: 200, signedIn })
        })
        for (const screen of screens) {
          test(`${screen.name}: controls and text fit`, async ({ page, request }, info) => {
            const files = screen.name === "files" || screen.name === "file-tabs"
            if (files) requires("codeStorage", "member")
            // A run that doesn't exist, or a member's page opened signed out: the server refuses it, and Chrome logs that.
            if (screen.name === "action-run" || screen.name === "run-unavailable") {
              expectServerError(signedIn ? 404 : 401, "/api/remote-runs/*")
              expectServerError(signedIn ? 403 : 401, "/api/shapes/remote-runs")
            }
            if (screen.name === "runs" && !signedIn) expectServerError(401, "/api/cloud-runs")
            await test.step(`Open ${screen.name}`, async () => {
              if (screen.name === "conversations" && signedIn) {
                requires("personalModel", "member", "ownConversation")
                await page.goto(ownPlace()?.path ?? "/octocat/Spoon-Knife/tree/test-branch")
                await expect(page.getByRole("navigation", { name: "Branch" })).toBeVisible({ timeout: 30_000 })
                await expect.poll(async () => {
                  const rows = await shapeRows<{ conversation_id: string; owner: string; repo: string; branch: string; archived_at: string | null }>(page.request, "/api/shapes/my-conversations")
                  const place = ownPlace()
                  return rows.some((row) => row.archived_at === null && (place === undefined
                    ? row.owner.toLowerCase() === "octocat" && row.repo.toLowerCase() === "spoon-knife" && row.branch === "test-branch"
                    : row.conversation_id === place.conversationId))
                }, { timeout: 30_000, message: "the opened branch must be recorded in this person's conversation shape" }).toBe(true)
              }
              if (files) {
                test.setTimeout(180_000)
                // Fixture writes use the stored test session; the visitor's page
                // and its requests remain signed out throughout the audit.
                const fixtureRequest = target === "deployment" && !signedIn
                  ? await apiRequests.newContext({ baseURL, storageState: sessionFiles(baseURL).session })
                  : request
                if (fixtureRequest !== request) redactRequestErrors(fixtureRequest)
                try {
                  const repository = { owner: "octocat", name: "Spoon-Knife" }
                  // A launch receipt isn't a finished clone. Prepare through the
                  // signed-in API before opening a signed-out page, which cannot
                  // subscribe to the members-only repositories shape.
                  const clone = await fixtureRequest.post("/api/repos", { headers: writeHeaders(), data: repository })
                  expect(clone.ok(), `the file fixture's real clone is admitted (HTTP ${clone.status()})`).toBe(true)
                  const { cloneId } = await clone.json() as { cloneId: string }
                  const launch = await fixtureRequest.post("/api/repos/launch", { headers: writeHeaders(), data: { ...repository, cloneId } })
                  expect(launch.ok(), "the file fixture's real clone is launched").toBe(true)
                  await expect.poll(async () => {
                    const refs = await fixtureRequest.get("/api/repos/octocat/Spoon-Knife/refs")
                    const body = await refs.json()
                    return { status: refs.status(), ...body }
                  }, { timeout: 120_000, message: "the Code Storage mirror must have main before file layout coverage" }).toMatchObject({
                    status: 200, branches: expect.arrayContaining([expect.objectContaining({ name: "main" })]),
                  })
                  await expect.poll(async () => (await shapeRows<{ id: string; status: string }>(fixtureRequest, "/api/shapes/repositories"))
                    .find((row) => row.id === "github/octocat/spoon-knife")?.status,
                  { timeout: 30_000, message: "the finished clone must reach the repositories shape before file layout coverage" }).toBe("ready")
                } finally {
                  if (fixtureRequest !== request) await fixtureRequest.dispose()
                }
              }
              await page.goto(screen.path)
              // Tracking needs sign-in; a visitor reads the public repository view,
              // without the private workspace's Branch navigation or terminal.
              const ready = (screen.name === "terminal" || screen.name === "branch") && !signedIn ? ".branch-screen-view" : screen.ready
              await expect(page.locator(ready).first()).toBeVisible({ timeout: 30_000 })
              if (screen.name === "conversations" && signedIn) await expect(page.getByRole("list", { name: "Conversations" })
                .locator(`a[href="${ownPlace()?.path ?? "/octocat/Spoon-Knife/tree/test-branch"}"]`)).toBeVisible({ timeout: 30_000 })
              if (screen.name === "secrets" && signedIn && me().role === "admin") await expect(page.getByRole("form", { name: "Add secret" })).toBeVisible({ timeout: 30_000 })
              if (screen.name === "repo-settings" && signedIn && ["admin", "maintainer"].includes(me().role ?? "")) await expect(page.getByRole("region", { name: "Domains" })).toBeVisible({ timeout: 30_000 })
              if (screen.name === "issue-unavailable" || (screen.name.startsWith("pull-") && screen.name.endsWith("-unavailable"))) {
                const main = page.getByRole("main")
                const unavailable = main.locator('[data-slot="empty-state"]').filter({ hasText: /Not found|unavailable here/ })
                await expect(unavailable.or(main.getByRole("link", { name: "Sign in with GitHub", exact: true })).first()).toBeVisible({ timeout: 60_000 })
              }
              if (screen.name === "action-run" || screen.name === "run-unavailable" || screen.name === "code-unavailable") {
                await expect(page.locator('main [data-slot="empty-state"]')).toBeVisible({ timeout: 30_000 })
              }
              if (screen.name === "raw-unavailable" || screen.name === "todo-unavailable") {
                await expect(page.locator('main [data-slot="empty-state"]').or(page.getByRole("link", { name: "Sign in with GitHub", exact: true })).first()).toBeVisible({ timeout: 60_000 })
              }
              if (screen.name === "plugin-path-unavailable") await expect(page.getByText("Not Found", { exact: true })).toBeVisible()
              if (screen.name === "doc-page") await expect(page.getByRole("heading", { name: "Retrying", exact: true }).first()).toBeVisible({ timeout: 60_000 })
              if (screen.name === "branch") await expect(page.locator(".branch-screen-view")).toBeVisible({ timeout: 30_000 })
              if (screen.name === "terminal" && !signedIn) await expect(page.locator(".terminal-panel")).toHaveCount(0)
            })
            if (screen.name === "home") {
              const conversations = page.getByRole("link", { name: "Conversations", exact: true })
              await expect(conversations).toBeVisible()
              await conversations.scrollIntoViewIfNeeded()
              const bounds = (await conversations.boundingBox())!
              expect(bounds.x).toBeGreaterThanOrEqual(0)
              expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
            }
            await audit(page, info)
          })
        }
        if (signedIn) test("view: a persisted page and its back link fit", async ({ page }, info) => {
          requires("member", "ownConversation")
          const id = crypto.randomUUID()
          const place = ownPlace()
          // Locally a page this machine serves, so the frame loads; a deployment can't read it, so there a real site.
          const served = target === "local" ? await serveFramedPage("A framed page") : undefined
          try {
            const response = await page.request.post("/api/views", { headers: writeHeaders(), data: {
              id, template: "webpage", ...(place === undefined ? {} : { conversationId: place.conversationId }),
              props: { url: served?.url ?? "https://example.com/", title: "A repository page with a long title on a narrow screen", description: "A persisted page opened at full size." },
            } })
            expect(response.status()).toBe(202)
            await page.goto(`/app/views/${id}${place === undefined ? "" : `?conversation=${place.conversationId}`}`)
            await expect(page.locator('[data-slot="web-page-view"]')).toBeVisible({ timeout: 30_000 })
            if (served !== undefined) await expect(page.frameLocator(".sui-web-page-frame").getByRole("heading", { name: "A framed page" })).toBeVisible()
            await audit(page, info, "view")
            await page.getByRole("link", { name: "Back to chat", exact: true }).click()
            await expect(page).toHaveURL(/\/app$/)
          } finally {
            await served?.close()
          }
        })
        if (signedIn) test("your model: controls and text fit", async ({ page }, info) => {
          requires("member")
          await page.goto("/app/settings")
          const form = page.getByRole("form", { name: "Your model", exact: true })
          await expect(form).toBeVisible()
          for (const name of ["OpenAI-compatible", "Anthropic-compatible"]) {
            const group = form.getByRole("group", { name, exact: true })
            await expect(group.getByRole("textbox", { name: `${name} Base URL`, exact: true })).toBeVisible()
            await expect(group.getByLabel(`${name} Key`, { exact: true })).toBeVisible()
          }
          for (const tier of ["Fast", "Implement", "Hard"]) {
            const key = form.getByRole("combobox", { name: `${tier} key`, exact: true })
            await expect(key).toBeVisible()
            await key.click()
            await page.getByRole("option", { name: "Anthropic-compatible", exact: true }).click()
            await expect(key).toHaveText("Anthropic-compatible")
          }
          await audit(page, info, "your-model", form)
        })
        if (signedIn) test("composer: controls and text fit", async ({ page }, info) => {
          requires("scriptedAgent")
          await page.goto(scriptedAgent("echo"))
          const composer = await openComposer(page)
          await composer.fill("Review mobile layouts and preserve all available actions on a narrow screen.")
          await audit(page, info)
        })
        if (signedIn) test("flow draft and code: controls and text fit", async ({ page }, info) => {
          requires("member")
          const name = `mobile-${crypto.randomUUID()}`
          const draftId = crypto.randomUUID()
          const source = renderSource({ name, description: "Mobile layout", instructions: "Answer ready.", flows: [] })
          expect((await page.request.post(`/api/flow-drafts/${draftId}`, { headers: writeHeaders(), data: {
            scope: "person", round: 0, request: "Answer ready.", name, status: "ready", summary: "Mobile layout",
            files: [{ path: SOURCE_PATH, text: source }], checks: [{ check: "parses", ok: true }], questions: [], failure: null, flowId: null,
          } })).ok()).toBe(true)
          await expect.poll(async () => (await shapeRows<{ id: string; status: string }>(page.request, "/api/shapes/flow-drafts"))
            .find((row) => row.id === draftId)?.status,
          { timeout: 30_000, message: "the ready draft must reach its person's shape before layout coverage" }).toBe("ready")
          await page.goto(`/app/flows/drafts/${draftId}`)
          const save = page.getByRole("button", { name: "Save", exact: true })
          await expect(save, "the persisted draft must load before layout coverage counts").toBeVisible({ timeout: 30_000 })
          await audit(page, info, "flow-draft")
          const saved = await page.request.post("/api/flows/save", { headers: writeHeaders(), data: { draftId, name, description: "Mobile layout", source, digest: digestSync(source) } })
          expect(saved.ok()).toBe(true)
          const { flowId } = await saved.json() as { flowId: string }
          try {
            await page.goto(`/app/flows/code/${name}`)
            await expect(page.getByRole("textbox", { name: "Code", exact: true })).toHaveValue(source, { timeout: 30_000 })
            await audit(page, info, "flow-code")
          } finally {
            expect((await page.request.post(`/api/flows/${flowId}/delete`, { headers: writeHeaders(), data: {} })).ok()).toBe(true)
          }
        })
        for (const kind of ["issues", "pulls"] as const) test(`${kind} detail: a synced item and its tabs fit`, async ({ page }, info) => {
          requires("githubApp", "syncedRepository")
          test.setTimeout(Math.max(info.timeout, 180_000))
          const repository = syncedRepository()
          const repoId = `github/${repository}`.toLowerCase()
          await expect.poll(async () => (await shapeRows<{ repo_id: string; kind: string; deleted_at: string | null }>(page.request, "/api/shapes/items"))
            .filter((row) => row.repo_id === repoId && row.kind === (kind === "issues" ? "issue" : "pull") && row.deleted_at === null).length,
          { timeout: 30_000, message: `the server must sync a real ${kind} fixture for ${repository}; an empty projection is a product failure` }).toBeGreaterThan(0)
          await page.goto(`/${repository}/${kind}`)
          // The server's projection and this browser's Electric snapshot are
          // different receipts. Wait for the actual list query to finish before
          // requiring a populated detail link; never accept an empty settled list.
          await expect(page.locator('[data-slot="issues-view"]')).toBeVisible({ timeout: 30_000 })
          await expect(page.locator('[data-slot="issues-view"]')).not.toHaveAttribute("aria-busy", "true", { timeout: 60_000 })
          const prefix = kind === "issues" ? "issues" : "pull"
          const item = page.locator(`a[href^="/${repository}/${prefix}/"]`).filter({ hasNotText: "New issue" }).first()
          await expect(item, "a real synced item is required; an empty list is not detail-page coverage").toBeVisible({ timeout: 30_000 })
          const href = await item.getAttribute("href")
          await item.click()
          await expect(page.locator("main article").first()).toBeVisible({ timeout: 60_000 })
          await audit(page, info, "detail")
          if (kind === "pulls") for (const tab of ["commits", "checks", "files"]) {
            await page.goto(`${href}/${tab}`)
            // Only Conversation renders an article; each other tab has its own content container.
            await expect(page.locator("main.pulls-screen > h1")).toBeVisible({ timeout: 60_000 })
            if (tab === "commits") await expect(page.getByRole("list", { name: "Commits", exact: true }).or(page.getByText("No commits", { exact: true }))).toBeVisible({ timeout: 60_000 })
            else if (tab === "checks") await expect(page.locator('[data-slot="run-list"]')).toBeVisible({ timeout: 60_000 })
            else await expect(page.getByRole("region", { name: "Files", exact: true })).toHaveAttribute("aria-busy", "false", { timeout: 60_000 })
            await audit(page, info, tab)
          }
        })
        if (signedIn) test("repository run: a real graph and journal fit", async ({ page }, info) => {
          requires("githubApp", "syncedRepository")
          const repository = syncedRepository()
          let execution: string | undefined
          await expect.poll(async () => {
            const rows = await shapeRows<{ execution: string | null }>(page.request, `/api/shapes/actions?repo=${encodeURIComponent(repository)}`)
            execution = rows.find((row) => typeof row.execution === "string" && row.execution !== "")?.execution ?? undefined
            return execution
          }, { timeout: 30_000, message: "a recorded repository run is required for populated deployment coverage" }).toBeTruthy()
          await page.goto(`/${repository}/actions/runs/${encodeURIComponent(execution!)}`)
          await expect(page.getByRole("group", { name: "Run graph" })).toBeVisible({ timeout: 30_000 })
          await audit(page, info, "repository-run")
          await page.getByRole("tab", { name: "Journal", exact: true }).click()
          await expect(page.locator('[data-slot="run-journal"]')).toBeVisible()
          await audit(page, info, "repository-journal")
        })
        if (signedIn) test("TODO: draft, stack and detail fit", async ({ page, todos }, info) => {
          requires("member", "writableStack")
          test.setTimeout(120_000)
          await page.goto(`/${stackRepository()}/stack`)
          await page.getByRole("button", { name: "New TODO" }).click()
          const draft = page.getByRole("form", { name: "TODO draft" }).first()
          const title = `Mobile layout ${crypto.randomUUID()}`
          await draft.getByLabel("Title").fill(title)
          await draft.getByLabel("Prompt").fill("Check that every control remains accessible on a narrow screen.")
          await audit(page, info, "draft")
          todos.push({ repository: stackRepository(), title })
          await draft.getByRole("button", { name: "Commit", exact: true }).click()
          const row = page.locator('[data-slot="issues-row"]', { hasText: title })
          await expect(row).toContainText(/T\d+/, { timeout: 60_000 })
          await audit(page, info, "stack")
          await row.getByRole("link", { name: title }).click()
          await expect(page.getByRole("article", { name: new RegExp(title) })).toBeVisible()
          await audit(page, info, "todo")
        })
        if (signedIn) test("run and queue: populated controls fit", async ({ page }, info) => {
          test.setTimeout(120_000)
          requires("scriptedAgent")
          await page.goto(scriptedAgent("needs-you"))
          // A real settled conversation makes the rail use multiple zoom levels
          // even when this case runs alone, without earlier route fixtures.
          for (let index = 0; index < 8; index++) {
            const answerId = crypto.randomUUID()
            expect((await page.request.post("/api/questions", { headers: writeHeaders(), data: {
              id: crypto.randomUUID(), answerId, text: `Inspect release regression ${index + 1}`,
            } })).status()).toBe(202)
            expect((await page.request.post(`/api/answers/${answerId}`, { headers: writeHeaders(), data: {
              // Longer than a label shows, so the rail asks the summary model for it, once (docs/features/timeline.md#cost).
              status: "done", text: `Release regression ${index + 1} checked both recorded attempts and found the missing projection entry.`,
            } })).status()).toBe(200)
          }
          const composer = await openComposer(page)
          const question = `Deploy the docs preview, mobile-${crypto.randomUUID()}`
          const accepted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/questions" && request.postDataJSON().text === question)
          await composer.fill(question)
          await composer.press("Enter")
          const { answerId } = (await accepted).postDataJSON() as { answerId: string }
          try {
            await expect(page.locator('[data-slot="needs-you"]').first()).toBeVisible({ timeout: 60_000 })
            const rail = page.getByRole("navigation", { name: "Conversation timeline" })
            const disclosure = page.locator(".sui-timeline-disclosure > summary")
            if (viewport.width < 1280) {
              await audit(page, info, "conversation")
              await disclosure.click()
            }
            await expect(rail.locator("button > span").filter({ hasText: "Release regression check completed" }).first()).toBeVisible({ timeout: 30_000 })
            await expect(async () => {
              const errors = await rail.evaluate((element) => {
                const failures: string[] = []
                for (const column of element.querySelectorAll<HTMLElement>("ol")) {
                  const bounds = column.getBoundingClientRect()
                  const rows = [...column.querySelectorAll<HTMLElement>(":scope > li")]
                  for (const row of rows) {
                    const box = row.getBoundingClientRect()
                    if (box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1) failures.push("row outside rail")
                    const label = row.querySelector<HTMLElement>("button > span")!
                    if (label.getBoundingClientRect().height > box.height + 1) failures.push("label outside row")
                  }
                  if (column.dataset.level === "0") {
                    const visible = rows.filter(row => row.hasAttribute("data-in-view"))
                    const band = column.querySelector<HTMLElement>(".sui-timeline-band")!.getBoundingClientRect()
                    if (visible.length && (Math.abs(band.top - visible[0]!.getBoundingClientRect().top) > 2 || Math.abs(band.bottom - visible.at(-1)!.getBoundingClientRect().bottom) > 2)) failures.push("band misses visible entries")
                  }
                }
                return failures
              })
              expect(errors).toEqual([])
            }).toPass({ timeout: 10_000 })
            await audit(page, info, viewport.width < 1280 ? "timeline" : "conversation", viewport.width < 1280 ? rail : undefined)
            if (viewport.width < 1280) {
              await disclosure.click()
              await expect(rail).toBeHidden()
              await expect(composer).toBeVisible()
            }
            await page.keyboard.press("Escape")
            await page.keyboard.press("g")
            await page.keyboard.press("q")
            await expect(page).toHaveURL(/\/app\/queue$/)
            await expect(page.getByRole("article", { name: "Item" })).toBeVisible()
            await audit(page, info, "question")
            await page.goto(`/app/runs/${answerId}`)
            await expect(page.getByRole("group", { name: "Run graph" })).toBeVisible({ timeout: 30_000 })
            await audit(page, info, "run")
            await page.getByRole("tab", { name: "Journal", exact: true }).click()
            await audit(page, info, "journal")
          } finally {
            await page.request.post(`/api/answers/${answerId}`, { headers: writeHeaders(), data: { status: "failed", failure: "unfinished" } })
            await page.request.post("/api/notifications/ack", { headers: writeHeaders(), data: { subject: `run:${answerId}`, version: 3, act: "dismiss" } })
          }
        })
        if (signedIn) test("toasts: several live notices fit", async ({ page }, info) => {
          // This fixture creates unfinished questions as the local developer.
          // Never enqueue them into a deployment's shared home conversation.
          requires("devSignIn")
          await page.goto("/app")
          await expect(page.getByRole("main", { name: "App" })).toBeVisible()
          const answers: string[] = []
          try {
            for (let index = 0; index < 5; index++) {
              const answerId = crypto.randomUUID()
              answers.push(answerId)
              expect((await page.request.post("/api/questions", { headers: writeHeaders(), data: { id: crypto.randomUUID(), answerId, text: `Mobile notice ${answerId}` } })).ok()).toBe(true)
              expect((await page.request.post(`/api/runs/${answerId}`, { headers: writeHeaders(), data: { status: "working" } })).ok()).toBe(true)
            }
            // A conversation intentionally suppresses its own working notices.
            await page.goto("/app/flows")
            await expect(page.locator('[data-slot="toast"]')).toHaveCount(3, { timeout: 30_000 })
            await audit(page, info)
          } finally {
            for (const answerId of answers) {
              await page.request.post(`/api/answers/${answerId}`, { headers: writeHeaders(), data: { status: "failed", failure: "unfinished" } })
              await page.request.post("/api/notifications/ack", { headers: writeHeaders(), data: { subject: `run:${answerId}`, version: 2, act: "dismiss" } })
            }
          }
        })
      })
    }
  })
}
