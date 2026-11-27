import { recordExchange, withAttachedAgent } from "./attach"
import { recordSummary } from "./timeline-fixture"
import { expect, test } from "./devices"
import { requires } from "./target"

requires("member", "ownConversation")

test("Timeline summaries: each question and answer keeps its own recorded words after reload", {
  annotation: { type: "summary", description: "Distinct recorded summaries replace the question and answer placeholders and survive a fresh page." },
}, async ({ devices }) => {
  test.setTimeout(180_000)
  const exchanges = [
    { question: "Investigate stale login cookie expiration", answer: "Fixed cookie expiry during session refresh" },
    { question: "Inspect release validation test coverage", answer: "Added missing checkout validation regression tests" },
  ].map(row => ({ ...row, id: crypto.randomUUID(), answerId: crypto.randomUUID() }))
  const [a] = await devices.open("Message summaries")
  await test.step("Record two completed exchanges", () => withAttachedAgent(a.page, async (agent) => {
    for (const row of exchanges) {
      const question = "Topic: summary proof. " + row.question
      const reply = "Topic: summary proof. " + row.answer
      await recordExchange(agent, { id: row.id, answerId: row.answerId, text: question }, reply)
      await recordSummary(a.page.request, { id: row.id, role: "user", text: question }, row.question)
      await recordSummary(a.page.request, { id: row.answerId, role: "assistant", text: reply }, row.answer)
    }
  }))
  const rail = a.page.getByRole("navigation", { name: "Conversation timeline" })
  const summaries = async () => {
    const toggle = a.page.locator(".sui-timeline-disclosure > summary")
    await expect(toggle).toBeVisible()
    await expect(rail).toBeHidden()
    await toggle.click()
    await expect(rail).toBeVisible()
    const labels: string[] = []
    for (const row of exchanges) for (const [id, expected] of [[row.id, row.question], [row.answerId, row.answer]]) {
      const entry = rail.locator(`ol[data-level="0"] button[aria-controls="${id}"]`)
      await expect(entry).toBeVisible()
      await expect(entry).toHaveAttribute("data-summary", "ready", { timeout: 90_000 })
      await expect(entry.locator(".sui-tl-tx")).toHaveText(expected!)
      labels.push((await entry.locator(".sui-tl-tx").textContent())!)
    }
    expect(new Set(labels).size).toBe(4)
  }
  await test.step("Read four distinct summaries", summaries)
  await test.step("Reload and read the same persisted summaries", async () => {
    await a.page.reload()
    await a.ready()
    await summaries()
  })
})
