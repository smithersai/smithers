import { allServerRows, expect, type Row, test } from "./devices"
import { home, requires, stackRepository } from "./target"

// Real model, real services, and the same UI on local and deployed builds. No scripted agent or dev identities.
requires("member", "ownConversation", "liveModel")

test("memory: a remembered language preference changes a later answer and Opening is visible in debug info", {
  annotation: { type: "summary", description: "Remember British English, reload, ask again and inspect opening memory in the run." },
}, async ({ devices, request }) => {
  test.setTimeout(300_000)
  const [a] = await devices.open("Writer")
  const remember = `Remember that I prefer British English. Save this preference with your memory tool. Reply saved when done. ${devices.word}`
  await a.askAndWaitTaken(remember)
  await a.expectAnswered(remember, "", 120_000)
  await expect(a.answerTo(remember)).toContainText(/saved/i)
  // A verbal promise alone is insufficient: the answer must carry the durable remember call.
  const remembered = (await allServerRows(request)).find((row) => row.id === a.asked.find((asked) => asked.text === remember)!.answerId) as (Row & { parts?: unknown }) | undefined
  const rememberParts = typeof remembered?.parts === "string" ? JSON.parse(remembered.parts) : remembered?.parts
  expect(rememberParts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "step", flow: "app/memory/remember", status: "done" })]))
  await a.reload()
  const question = `Write one sentence mentioning the color, neighbor, favorite, and theater concepts, using my saved spelling preference. ${devices.word}`
  await a.askAndWaitTaken(question)
  await a.expectAnswered(question, "colour", 120_000)
  const answer = a.answerTo(question)
  await expect(answer).toContainText("neighbour")
  await expect(answer).toContainText("favourite")
  await expect(answer).toContainText("theatre")
  await expect(answer).not.toContainText(/\b(color|neighbor|favorite|theater)\b/i)
  await answer.hover()
  await answer.getByRole("link", { name: "Debug info" }).click()
  const graph = a.page.getByRole("group", { name: "Run graph" })
  const opening = graph.getByRole("button", { name: "chat/Opening, Done", exact: true })
  await expect(opening).toBeVisible({ timeout: 30_000 })
  await opening.click()
  await opening.press("Enter")
  const inspector = a.page.locator('[data-slot="step-inspector"]')
  await expect(inspector).toHaveAttribute("aria-label", "Inspect chat/Opening")
  await inspector.getByRole("tab", { name: "Output" }).click()
  const output = inspector.locator('[data-slot="json-value"]').filter({ hasText: "Output" })
  const value = JSON.parse((await output.locator("pre").textContent())!) as { memoryDebug: { inserted: number } }
  expect(value.memoryDebug.inserted, "the later turn actually used stored memory").toBeGreaterThan(0)
})

test("todo status: the agent reports the scratch TODO's shared dropped state", {
  annotation: { type: "summary", description: "Create and drop a scratch TODO, then ask the agent for its shared status." },
}, async ({ devices, request }) => {
  requires("writableStack")
  test.setTimeout(300_000)
  const repository = stackRepository()
  const [a] = await devices.open("Author")
  const page = a.page
  const title = `Status proof ${devices.word}`
  await page.goto(`/${repository}/stack`)
  const stack = page.getByRole("region", { name: `${repository} stack` })
  await expect(stack).toBeVisible({ timeout: 60_000 })
  await page.getByRole("button", { name: "New TODO" }).click()
  const draft = page.getByRole("form", { name: "TODO draft" }).first()
  await draft.getByLabel("Title").fill(title)
  await draft.getByLabel("Prompt").fill("Describe the README. Do not change any files.")
  await draft.getByRole("button", { name: "Commit" }).click()
  const row = stack.locator("[data-slot=issues-row]", { hasText: title })
  await expect(row).toContainText(/T\d+/, { timeout: 60_000 })
  await expect(row).not.toHaveAttribute("data-pending", /.+/, { timeout: 60_000 })
  const number = (await row.textContent())!.match(/T(\d+)/)![1]!
  // Drop before asking, so the shared state is stable even if the factory began execution.
  // This is also cleanup: the test never leaves a queued TODO after a model failure.
  await row.getByRole("link", { name: title, exact: true }).click()
  const card = page.getByRole("article", { name: new RegExp(title) })
  await card.getByRole("button", { name: "Drop", exact: true }).click()
  await page.getByRole("dialog", { name: `Drop T${number}?` }).getByRole("button", { name: "Drop", exact: true }).click()
  await expect(card).toHaveAttribute("data-status", "dropped", { timeout: 60_000 })
  await page.goto(home())
  await a.ready()
  const question = `What is the status of T${number} in ${repository}? Check the shared TODO state, not this device's runs. ${devices.word}`
  await a.askAndWaitTaken(question)
  await a.expectAnswered(question, "", 120_000)
  await expect(a.answerTo(question)).toContainText(/\bdropped\b/i)
  await expect(a.answerTo(question)).toContainText(`T${number}`)
  const answered = (await allServerRows(request)).find((row) => row.id === a.asked.find((asked) => asked.text === question)!.answerId) as (Row & { parts?: unknown }) | undefined
  const parts = typeof answered?.parts === "string" ? JSON.parse(answered.parts) : answered?.parts
  expect(parts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "step", flow: "todo/inspect", status: "done" })]))
  await expect(a.answerTo(question)).not.toContainText(/not (?:yet )?started|hasn't started/i)
})
