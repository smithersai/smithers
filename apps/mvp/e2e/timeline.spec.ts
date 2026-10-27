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
  const initialHeights = await rowHeights()
  await test.step("Receive navigation summaries", async () => {
    await expect.poll(() => rail.locator('[data-summary="ready"]').count(), { timeout: 90_000 }).toBeGreaterThan(0)
    expect((await a.conversation.boundingBox())!.width).toBe(transcriptWidth)
    expect(initialHeights.every(height => height > 0)).toBe(true)
    expect(await rowHeights()).toEqual(initialHeights)
    expect(await rail.getByRole("button").evaluateAll(buttons => buttons.every(button => {
      const row = button.getBoundingClientRect()
      const column = button.closest("ol")!.getBoundingClientRect()
      const label = button.querySelector("span")!.getBoundingClientRect()
      return row.top >= column.top - 1 && row.bottom <= column.bottom + 1 && label.height <= row.height + 1
    }))).toBe(true)
  })
  await test.step("Preview an entry on hover and focus", async () => {
    await a.page.locator(`[id="${firstQuestionId}"]`).scrollIntoViewIfNeeded()
    const first = detail.locator(`button[aria-controls="${firstQuestionId}"]`)
    await expect(first).toBeVisible()
    const preview = first.locator("..").getByRole("tooltip")
    await expect(preview).toBeHidden()
    await first.hover()
    await expect(preview).toBeVisible()
    await expect(preview).toContainText("Person")
    await expect(preview).toContainText("Enter to jump")
    const transcript = (await a.conversation.boundingBox())!
    const box = (await preview.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(transcript.x)
    await expect(first.locator("span")).toHaveCSS("white-space", "nowrap")
    await expect(first.locator("span")).toHaveCSS("overflow", "hidden")
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
  await test.step("Scroll the transcript and follow its band", async () => {
    await a.conversation.locator('[data-slot="message-scroller-viewport"]').evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect(detail.getByRole("button").last()).toHaveAttribute("aria-current", "location")
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
    await expect(async () => {
      expect(await rail.getByRole("button").evaluateAll(buttons => buttons.every(button => {
        const box = button.getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return hit !== null && button.contains(hit)
      }))).toBe(true)
    }).toPass({ timeout: 10_000 })
    await detail.getByRole("button").first().focus()
    await expect(detail.getByRole("tooltip").first()).toBeVisible()
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

test("Branch timeline: question, reply, run and TODO name their objects", {
  annotation: { type: "summary", description: "Every branch entry identifies the question, flow or TODO while summaries arrive." },
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
    const ours = async () => {
      const labels = await rows.allTextContents()
      const first = labels.findIndex((label) => label.includes(`todo-draft octocat/Spoon-Knife ${word}`))
      return first === -1 ? [] : labels.slice(first)
    }
    await expect.poll(async () => (await ours()).filter((label) => label.includes("chat/Answer · completed")).length, { timeout: 30_000 })
      .toBe(1)
    await expect(rows.filter({ hasText: `README release ${word} · draft` })).toHaveCount(1)
    await expect.poll(async () => (await ours()).length).toBe(4)
    for (const label of await rows.allTextContents()) {
      expect(label.trim()).not.toMatch(/^(?:(?:Reply|Question|Answer|Tool|Run|TODO) (?:sent|completed|done|failed|queued|opened)|Working|Waiting(?: to send| for reply)?|Needs you|Not sent|Done|Failed|Queued)$/i)
      expect(label.trim().length).toBeGreaterThan(0)
    }
    await rows.last().click()
    await expect(a.page.getByRole("form", { name: "TODO draft" })).toBeInViewport()
  })
})
