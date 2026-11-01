import { expect, test } from "./devices"
import { requires, scriptedAgent } from "./target"

requires("scriptedAgent", "member")

test("Timeline summaries: each question and answer keeps its own model words after reload", {
  annotation: { type: "summary", description: "Distinct model summaries replace the question and answer placeholders and survive a fresh page." },
}, async ({ devices, request }) => {
  test.setTimeout(180_000)
  const exchanges = [
    { question: "Investigate stale login cookie expiration", answer: "Fixed cookie expiry during session refresh" },
    { question: "Inspect release validation test coverage", answer: "Added missing checkout validation regression tests" },
  ].map(row => ({ ...row, id: crypto.randomUUID(), answerId: crypto.randomUUID() }))
  await test.step("Record two completed exchanges", async () => {
    for (const row of exchanges) {
      expect((await request.post("/api/questions", { data: { id: row.id, answerId: row.answerId, text: `Topic: summary proof. ${row.question}` } })).status()).toBe(202)
      expect((await request.post(`/api/answers/${row.answerId}`, { data: { status: "done", text: `Topic: summary proof. ${row.answer}` } })).status()).toBe(200)
    }
  })
  const [a] = await devices.open("Message summaries")
  await a.page.goto(scriptedAgent("echo"))
  await a.ready()
  const rail = a.page.getByRole("navigation", { name: "Conversation timeline" })
  const summaries = async () => {
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
  await test.step("Read four distinct model summaries", summaries)
  await test.step("Reload and read the same persisted summaries", async () => {
    await a.page.reload()
    await a.ready()
    await summaries()
  })
})
