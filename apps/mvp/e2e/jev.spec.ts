import type { BrowserContext } from "@playwright/test"
import { allServerRows, expect, type Row, test } from "./devices"
import { step } from "./fixtures"
import { requires } from "./target"

// Jev in the agent's hands, end to end (docs/features/jev.md): a real browser asks Smithers to sort issue titles and
// never names Jev. The agent picks `app/jev/classify` on its own, from the flow's description in its catalog, and the
// judgment goes through ChatApi's metered endpoint as role `judge` (`POST /api/model/judge`, the real model). The
// answer's debug info opens the run that answered it: its flow view shows the Jev step, whose output holds the
// verdicts, and the step's own run holds its input. Opening memory may also call `judge` (docs/features/memory.md).

/** Every model call this browser context made, by role: the engine worker's requests to the model endpoint. */
const modelCalls = (context: BrowserContext) => {
  const calls: Array<string> = []
  context.on("request", (request) => {
    const { pathname } = new URL(request.url())
    if (request.method() === "POST" && pathname.startsWith("/api/model/")) calls.push(pathname.slice("/api/model/".length))
  })
  return calls
}

/** The flow steps the answer to `question` shows, as Postgres holds them (`messages.parts`). */
const stepsOf = (rows: Array<Row>, question: string): Array<{ flow: string; status: string }> => {
  const asked = rows.find((row) => row.role === "user" && row.text === question)
  const answer = rows.find((row) => asked !== undefined && row.question_id === asked.id) as (Row & { parts?: unknown }) | undefined
  const parts = typeof answer?.parts === "string" ? JSON.parse(answer.parts) : answer?.parts ?? []
  return (parts as Array<{ kind: string; flow: string; status: string }>).filter((part) => part.kind === "step")
}

/** Nine issue titles: three bugs (1, 4, 7), three features (2, 5, 8) and three questions (3, 6, 9). */
const TITLES = [
  "Crash when saving a file with an emoji in its name",
  "Add a dark mode to the settings page",
  "How do I connect my GitHub account?",
  "Login button does nothing on Safari",
  "Support exporting reports as CSV",
  "Is there a limit on repository size?",
  "Search results still show deleted issues",
  "Let me pin conversations to the sidebar",
  "Which browsers are supported?",
]

/**
 * The ask, which never names Jev; the agent eval `jev-sort` sorts the same titles (evals/cases.ts `SORT_TITLES`). The
 * milestone is the test's own word, so the question is this run's in the shared conversation.
 */
const sortTitles = (milestone: string) =>
  `Sort these issue titles from milestone ${milestone} into bug, feature and question: ` +
  TITLES.map((title, i) => `${i + 1}. ${title}`).join(" ")

test("jev: asked to sort issue titles, the agent uses Jev unasked, and debug info shows its step", {
  annotation: { type: "summary", description: "The agent picks Jev on its own; debug info shows the Jev step, its output and its input." },
}, async ({ devices, request }) => {
  requires("personalModel", "member", "ownConversation")
  test.setTimeout(240_000)
  const [a] = await devices.open("A")
  const calls = modelCalls(a.device.context)
  const question = sortTitles(devices.word)
  const answer = a.answerTo(question)
  const graph = a.page.getByRole("group", { name: "Run graph" })
  const inspector = a.page.locator('[data-slot="step-inspector"]')

  await step("Ask to sort the titles, without naming Jev", async () => {
    await a.askAndWaitTaken(question)
  })

  await step("See the answer", async () => {
    await expect(answer, "the answer settles").toHaveAttribute("data-state", "done", { timeout: 180_000 })
    await expect(answer.locator('[data-slot="message-response"]')).toHaveAttribute("data-streaming", "false")
    await expect(answer).toContainText(/bug/i)
    await expect(answer).toContainText(/feature/i)
    await expect(answer).toContainText(/question/i)
    // Exactly one classification settled. Browser-wide judge traffic also includes `chat/Opening/model`
    // for memory and skill selection (docs/features/memory.md); it isn't a second classification.
    expect(stepsOf(await allServerRows(request), question)).toEqual([expect.objectContaining({ flow: "app/jev/classify", status: "done" })])
    expect(calls.filter((role) => role === "judge").length).toBeGreaterThan(0)
  })

  await step("Open debug info", async () => {
    // Debug info shows only while the pointer is over the answer (FE-13).
    await a.page.mouse.move(4, 4)
    await expect(answer.locator(".sui-chat-message-actions")).toHaveCSS("opacity", "0")
    await answer.hover()
    await expect(answer.locator(".sui-chat-message-actions")).toHaveCSS("opacity", "1")
    await answer.getByRole("link", { name: "Debug info" }).click()
    const { answerId } = a.asked.find((asked) => asked.text === question)!
    await expect(a.page).toHaveURL(new RegExp(`/app/runs/${encodeURIComponent(answerId)}$`))
    await expect(graph).toBeVisible({ timeout: 30_000 })
  })

  const jev = graph.getByRole("button", { name: /^app\/jev\/classify\/judge, Done$/ })
  await step("See the Jev step in the flow view", async () => {
    await expect(jev, "the flow view shows the Jev step").toBeVisible({ timeout: 30_000 })
    // Down traverses recorded steps, including opening memory and settlement cleanup, to the Jev step.
    await graph.focus()
    for (const node of await graph.getByRole("button").all()) {
      await a.page.keyboard.press("ArrowDown")
      await expect(node, "Down highlights the next step").toHaveAttribute("data-selected", "true")
      if (await node.getAttribute("aria-label") === "app/jev/classify/judge, Done") break
    }
    await expect(jev, "the Jev step is highlighted").toHaveAttribute("data-selected", "true")
    await a.page.keyboard.press("Enter")
  })

  await step("Open the Jev step's output", async () => {
    await expect(inspector).toHaveAttribute("aria-label", "Inspect app/jev/classify/judge")
    await inspector.getByRole("tab", { name: "Output" }).click()
    const output = inspector.locator('[data-slot="json-value"]').filter({ hasText: "Output" })
    await expect(output).toContainText('"verdicts"')
    const verdicts = JSON.parse((await output.locator("pre").textContent())!) as { verdicts: Array<{ verdict: string }> }
    expect(verdicts.verdicts, "one verdict per title").toHaveLength(TITLES.length)
    // Scroll through the nine verdicts, the Jev step still highlighted beside them.
    const pre = output.locator("pre")
    const scrolled = () => pre.evaluate((element) => {
      let node: Element | null = element
      while (node !== null && node.scrollHeight <= node.clientHeight) node = node.parentElement
      return node?.scrollTop ?? 0
    })
    await pre.hover()
    for (let turn = 1; turn <= 2; turn++) {
      const before = await scrolled()
      await a.page.mouse.wheel(0, 150)
      await expect.poll(scrolled, "the verdicts scroll").toBeGreaterThan(before)
    }
    await expect(jev).toHaveAttribute("data-selected", "true")
  })

  await step("Open the Jev step's input", async () => {
    // An action records no input; the step's own run, app/jev/classify, holds what the agent asked Jev.
    await inspector.getByRole("link", { name: "Open" }).click()
    await expect(a.page.getByRole("main", { name: "Run" })).toContainText("app/jev/classify", { timeout: 30_000 })
    const input = a.page.locator('[data-slot="json-value"]').filter({ hasText: /^Input/ }).first()
    await input.locator("summary").click()
    for (const title of TITLES) await expect(input, `the input holds "${title}"`).toContainText(title)
    await expect(input).toContainText('"labels"')
    await expect(a.page.locator('[data-slot="json-value"]').filter({ hasText: /^Result/ }).first()).toContainText('"verdicts"')
  })
})
