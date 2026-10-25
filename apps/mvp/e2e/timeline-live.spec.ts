import { expect, test } from "./devices"
import { step } from "./fixtures"
import { ownPlace, requires } from "./target"

// Separate from timeline.spec.ts: its two scripted journeys require a dev build.
requires("personalModel", "member", "ownConversation", "liveModel")

test("Branch timeline: a real question and its reply retain their object and outcome", {
  annotation: { type: "summary", description: "The rail names this question and its linked reply, with a successful answer and a specific question label." },
}, async ({ devices }) => {
  test.setTimeout(240_000)
  // devices.open installs recordActions and uses the signed-in account's own branch on a deployment.
  const [a] = await devices.open("Timeline")
  const path = ownPlace()?.path ?? "/octocat/Spoon-Knife/tree/main"
  await step("Open the branch conversation", async () => {
    if (new URL(a.page.url()).pathname !== path) await a.page.goto(path)
    await expect(a.page.getByRole("navigation", { name: "Branch", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(a.page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0, { timeout: 60_000 })
  })
  // Six words: the entire subject fits the recorded eight-word label, independently of either model's wording.
  const question = `Timeline check ${devices.word}: reply exactly ok`
  const rail = a.page.getByRole("navigation", { name: "Conversation timeline" })
  const entries = rail.getByRole("list", { name: "Zoom level 0", exact: true })

  await step("Ask a question on the branch", async () => {
    await a.askAndWaitTaken(question)
  })
  const { questionId, answerId } = a.asked.find(asked => asked.text === question)!
  const asked = entries.locator(`button[aria-controls="${questionId}"]`)
  const replied = entries.locator(`button[aria-controls="${answerId}"]`)
  await step("Find the question by its first words in the timeline", async () => {
    if (!(await rail.isVisible())) await a.page.locator(".sui-timeline-disclosure > summary").click()
    await expect(asked).toBeVisible({ timeout: 30_000 })
    await expect(asked).toHaveAccessibleName(new RegExp(question))
    await asked.click()
    await expect(a.question(question)).toHaveAttribute("id", questionId)
    await expect(a.question(question)).toBeInViewport()
  })

  await step("See the linked reply settle in the timeline", async () => {
    // A 202 acknowledges the question, before Electric mounts its answer. Give that projection the live-model
    // budget too, then follow the rail's actual link before checking its target.
    await expect(replied).toBeVisible({ timeout: 180_000 })
    const targetId = await replied.getAttribute("aria-controls")
    expect(targetId).toBe(answerId)
    await replied.click()
    const answer = a.conversation.locator(`[id="${targetId}"]`)
    await expect(answer).toHaveAttribute("data-role", "assistant")
    await expect(answer).toHaveAttribute("data-state", "done", { timeout: 180_000 })
    await expect(answer.locator('[data-slot="message-response"]')).toContainText("ok")
    await expect(replied).toBeVisible()
    await expect(replied).toHaveAccessibleName(new RegExp(`${question} · answered$`))
    // A generated summary may paraphrase the question; its visible text must still say more than a generic outcome.
    await expect(replied).toContainText(new RegExp(`timeline|${devices.word}`, "i"))
    await expect(replied).not.toHaveText(/^\s*(?:(?:reply|answer|response)(?: (?:sent|received|completed|done|successfully))*|answered|done|ok)[.!]?\s*$/i)
    await expect(replied.locator("..")).toHaveAttribute("data-state", "done")
    await replied.click()
    await expect(answer).toBeInViewport()
    await expect(answer.locator('[data-slot="message-response"]')).toHaveAttribute("data-streaming", "false")
  })
})
