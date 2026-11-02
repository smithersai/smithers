import { expect, test } from "./devices"
import { requires, scriptedAgent } from "./target"
import { openComposer } from "./composer"

// The scripted agent's model (a dev build) answers, and the test records questions and answers, which needs a Member.
requires("scriptedAgent", "member")

test("Conversation timeline: scroll, jump by key and receive durable summaries", {
  annotation: { type: "summary", description: "A long conversation stays in sync with its rail; keys jump and summaries remain readable inside the available rail." },
}, async ({ devices, request }) => {
  test.setTimeout(180_000)
  const [a] = await devices.open("Timeline")
  await a.page.goto(scriptedAgent("echo"))
  await a.ready()
  const word = `rail-${Date.now()}`
  const firstQuestionId = crypto.randomUUID()
  await test.step("Build a long conversation", async () => {
    // Another real API client records the conversation, as in local-first-conflicts.spec.ts.
    // This journey tests rail navigation and summaries independently of the agent-answer journey.
    for (let n = 0; n < 8; n++) {
      const id = n === 0 ? firstQuestionId : crypto.randomUUID()
      const answerId = crypto.randomUUID()
      const question = `Inspect release retry ${n + 1}: ${word}`
      const asked = await request.post("/api/questions", { data: { id, answerId, text: question } })
      expect(asked.status()).toBe(202)
      const answered = await request.post(`/api/answers/${answerId}`, {
        data: { status: "done", text: `Release retry ${n + 1} retained both recorded attempts. The check found a missing projection entry. ${word}` },
      })
      expect(answered.status()).toBe(200)
    }
    await expect(a.conversation.locator('[data-role="assistant"]', { hasText: word })).toHaveCount(8, { timeout: 30_000 })
  })
  const rail = a.page.getByRole("navigation", { name: "Conversation timeline" })
  await expect(rail).toBeVisible()
  const detail = rail.locator('ol[data-level="0"]')
  const transcriptWidth = (await a.conversation.boundingBox())!.width
  const rowHeights = () => rail.getByRole("button").evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height))
  await test.step("Receive navigation summaries", async () => {
    await expect.poll(() => rail.locator('[data-summary="ready"]').count(), { timeout: 90_000 }).toBeGreaterThan(0)
    expect((await a.conversation.boundingBox())!.width).toBe(transcriptWidth)
    expect((await rowHeights()).every(height => height > 0)).toBe(true)
    // Marks follow the transcript (FE-22), so a label may outgrow its mark; labels never land on each other.
    expect(await detail.locator('.sui-tl-row:not([data-label="hidden"]) .sui-tl-tx').evaluateAll(labels => labels
      .map(label => label.getBoundingClientRect()).every((box, index, all) => index === 0 || box.top >= all[index - 1]!.bottom - 1))).toBe(true)
  })
  await test.step("Preview an entry on hover and focus", async () => {
    await a.page.locator(`[id="${firstQuestionId}"]`).scrollIntoViewIfNeeded()
    const first = detail.locator(`button[aria-controls="${firstQuestionId}"]`)
    await expect(first).toBeVisible()
    const preview = rail.getByRole("tooltip")
    await expect(preview).toBeHidden()
    await first.locator(".sui-tl-mk").hover({ timeout: 10_000 })
    await expect(preview).toBeVisible()
    await expect(preview).toContainText("Person")
    expect((await preview.boundingBox())!.x).toBeGreaterThanOrEqual(0)
    await a.page.mouse.move(1100, 20)
    await expect(preview).toBeHidden()
    await first.focus()
    await expect(preview).toBeVisible()
  })
  await test.step("Jump to the beginning by key", async () => {
    const last = detail.getByRole("button").last()
    await last.focus()
    const homeId = await detail.getByRole("button").first().getAttribute("aria-controls")
    await last.press("Home")
    const first = detail.locator(`button[aria-controls="${homeId}"]`)
    await expect(first).toBeFocused()
    await expect(first).toHaveAttribute("aria-current", "location")
    const nextId = await first.evaluate(button => button.closest("li")!.nextElementSibling!.querySelector("button")!.getAttribute("aria-controls"))
    await first.press("ArrowDown")
    await expect(detail.locator(`button[aria-controls="${nextId}"]`)).toBeFocused()
  })
  const wheelRail = async () => {
    const viewport = a.conversation.locator('[data-slot="message-scroller-viewport"]')
    const latest = a.conversation.locator('[data-slot="message-scroller-button"][data-target="end"]')
    // Use the real follow command, after earlier keyboard navigation has finished settling.
    await expect(async () => {
      if (await latest.getAttribute("data-active") === "true") await latest.click({ timeout: 1000 })
      expect(await viewport.evaluate(el => new Promise<boolean>(resolve => {
        let frames = 0
        const check = () => {
          if (el.scrollHeight - el.clientHeight - el.scrollTop > 1) { resolve(false); return }
          if (++frames === 30) resolve(true)
          else requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }))).toBe(true)
      await expect(latest).toHaveAttribute("data-active", "false")
    }).toPass({ timeout: 15_000 })
    const current = () => detail.locator('[aria-current="location"]').evaluateAll(rows => rows.map(row => row.getAttribute("aria-controls")))
    const before = await current()
    const top = await viewport.evaluate(el => el.scrollTop)
    await rail.hover({ position: { x: 12, y: 12 } })
    // Exercise the browser's real modifier support: happy-dom's WheelEvent omits MouseEvent modifiers.
    expect(await rail.evaluate(el => {
      const viewport = el.closest(".sui-chat-transcript")!.querySelector('[data-slot="message-scroller-viewport"]')!
      const top = viewport.scrollTop
      const pinch = new WheelEvent("wheel", { deltaY: 600, ctrlKey: true, bubbles: true, cancelable: true })
      el.dispatchEvent(pinch)
      return { prevented: pinch.defaultPrevented, moved: viewport.scrollTop !== top }
    })).toEqual({ prevented: false, moved: false })
    await a.page.mouse.wheel(0, -600)
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeLessThan(top - 500)
    await expect.poll(current).not.toEqual(before)
    const up = await viewport.evaluate(el => el.scrollTop)
    // Hover/focus commits the real rail preview; successive frames must not re-pin the live edge.
    await detail.locator('[aria-current="location"]').first().locator(".sui-tl-mk").hover({ timeout: 10_000 })
    await viewport.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBe(up)
    await expect(a.conversation.locator('[data-slot="message-scroller-button"][data-target="end"]')).toHaveAttribute("data-active", "true")
    await rail.hover({ position: { x: 12, y: 12 } })
    await a.page.mouse.wheel(0, 400)
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(up + 300)
  }
  await test.step("Scroll the conversation with the wheel over its rail", wheelRail)
  await test.step("Scroll the transcript and follow its band", async () => {
    await a.conversation.locator('[data-slot="message-scroller-viewport"]').evaluate(el => { el.scrollTop = el.scrollHeight })
    // Another project may be asking in the shared conversation: the row named here is the last when this step began.
    const lastId = await detail.getByRole("button").last().getAttribute("aria-controls")
    await expect(detail.locator(`button[aria-controls="${lastId}"]`)).toHaveAttribute("aria-current", "location")
    await detail.getByRole("button").nth(1).press("End")
    await expect(detail.getByRole("button").last()).toBeFocused()
  })
  for (const viewport of [{ width: 1024, height: 800 }, { width: 1024, height: 600 }, { width: 390, height: 844 }]) await test.step(`Keep the open rail reachable at ${viewport.width}×${viewport.height}`, async () => {
    await a.page.setViewportSize(viewport)
    const composer = await openComposer(a.page)
    await expect(composer).toBeVisible()
    await expect(rail).toBeHidden()
    await expect(a.conversation).toBeVisible()
    const toggle = a.page.locator(".sui-timeline-disclosure > summary")
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(rail).toBeVisible()
    await test.step("Scroll from the open timeline sheet", wheelRail)
    await expect(async () => {
      // Rows beyond the window a level shows are clipped until it pages to them.
      expect(await rail.getByRole("button").evaluateAll(buttons => buttons.filter(button => {
        const box = button.getBoundingClientRect(), clip = button.closest(".sui-tl-clip")!.getBoundingClientRect()
        return box.top >= clip.top && box.bottom <= clip.bottom
      }).every(button => {
        const box = (button.querySelector(".sui-tl-mk") ?? button).getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return hit !== null && button.contains(hit)
      }))).toBe(true)
    }).toPass({ timeout: 10_000 })
    await detail.getByRole("button").first().focus()
    await expect(rail.getByRole("tooltip")).toBeVisible()
    await toggle.focus()
    await toggle.press("Enter")
    await expect(rail).toBeHidden()
    await toggle.press("Enter")
    await expect(rail).toBeVisible()
    await detail.getByRole("button").first().press("Escape")
    await expect(rail).toBeHidden()
    await expect(toggle).toBeFocused()
  })
})

// Only questions and answers join the rail: a TODO draft, its run and its tool calls add no entries (FE-16,
// docs/features/timeline.md#entry-text).
test("Branch timeline: a TODO draft's question and answer name themselves, and the draft adds no entry", {
  annotation: { type: "summary", description: "On a branch, the rail holds the question and its answer, each named, and no row for the TODO draft." },
}, async ({ devices }) => {
  test.setTimeout(180_000)
  const [a] = await devices.open("Branch timeline")
  await a.page.goto(scriptedAgent("todo-draft", "/octocat/Spoon-Knife/tree/main"))
  await expect(a.page.getByRole("navigation", { name: "Branch", exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(a.page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0, { timeout: 60_000 })
  const word = devices.word
  await test.step("Ask for a README TODO on the branch", async () => {
    await a.askAndWaitTaken(`todo-draft octocat/Spoon-Knife ${word}`)
    await expect(a.page.getByRole("form", { name: "TODO draft" })).toBeVisible({ timeout: 120_000 })
    await a.page.getByRole("form", { name: "TODO draft" }).getByLabel("Title").fill(`README release ${word}`)
  })
  await test.step("Read the objects in the timeline", async () => {
    const rail = a.page.getByRole("navigation", { name: "Conversation timeline" })
    if (!(await rail.isVisible())) await a.page.locator(".sui-timeline-disclosure > summary").click()
    const rows = rail.locator('ol[data-level="0"] button')
    // The branch's conversation is shared with every spec that asks on octocat/Spoon-Knife's main, so earlier entries
    // can sit above this test's: its own are its question's row and every row after it.
    // A row's words become its summary as soon as one arrives, so this test's question is found by what it anchors to.
    const ours = () => rows.evaluateAll((buttons, asked) => {
      const first = buttons.findIndex((button) => document.getElementById(button.getAttribute("aria-controls") ?? "")?.textContent?.includes(asked))
      return first === -1 ? [] : buttons.slice(first).map((button) => button.textContent ?? "")
    }, `todo-draft octocat/Spoon-Knife ${word}`)
    await expect.poll(async () => (await ours()).length, { timeout: 30_000 }).toBeGreaterThan(1)
    await expect.poll(async () => (await ours()).length).toBe(2)
    await expect(rows.filter({ hasText: `README release ${word}` })).toHaveCount(0)
    for (const label of await rows.allTextContents()) {
      expect(label.trim()).not.toMatch(/^(?:(?:Reply|Question|Answer|Tool|Run|TODO) (?:sent|completed|done|failed|queued|opened)|Working|Waiting(?: to send| for reply)?|Needs you|Not sent|Done|Failed|Queued)$/i)
      expect(label.trim().length).toBeGreaterThan(0)
    }
    await rows.last().click()
    await expect(a.page.getByRole("form", { name: "TODO draft" })).toBeInViewport()
  })
})
