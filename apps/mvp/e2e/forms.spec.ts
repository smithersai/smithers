import type { Page } from "@playwright/test"
import type { FormWrite } from "../src/features/views/schema"
import { step } from "./fixtures"
import { expect, test } from "./devices"
import { ownPlace, requires, scriptedAgent } from "./target"

// The agent asks with a form (docs/features/views.md#forms, decision 0004 §3), end to end: the real app, ChatApi and
// Postgres, with the agent's model the only scripted seam (`/app?agent=form`, src/test/scriptedAgent.ts), so it asks
// the same way every time. The agent calls `ui/form`; the form shows in the conversation on every device; the person
// fills it and presses its button; the submission is their next question, with the values; and the agent's next answer
// reads them. The form stays answered on every device and after a reload.

/** The latest form in the conversation on `page`. */
const latestForm = (page: Page) => page.locator('.conversation-view[data-template="form"]').last()

test("ask with a form: the agent asks with a form, the person submits it, and the agent goes on with the values", {
  annotation: {
    type: "summary",
    description: "The agent asks which repository with a form; the person fills and sends it; the agent answers with what they sent.",
  },
}, async ({ devices }) => {
  requires("personalModel", "scriptedAgent", "member", "ownConversation")
  test.setTimeout(240_000)
  const word = devices.word
  const [a, b] = await devices.open("A", "B")
  await a.page.goto(scriptedAgent("form"))
  await a.ready()

  const question = `Clone a repository for me, ${word}`
  await a.askAndWaitTaken(question)
  // The agent asks with a form, not in prose: it shows in the conversation on both devices.
  for (const tab of [a, b]) {
    await expect(latestForm(tab.page), `${tab.name}: the agent's form shows`).toContainText("Which repository?", {
      timeout: 60_000,
    })
  }
  await a.expectAnswered(question, "Which repository")

  const url = `https://github.com/octocat/${word}`
  await step("A: fill the form and send it", async () => {
    const form = latestForm(a.page)
    await form.getByLabel("Repository URL").fill(url)
    await form.getByRole("button", { name: "Clone" }).click()
  })
  // The submission is A's next question, and the agent's next answer goes on with what A sent.
  await expect(a.page.getByText(`Got it. I'll clone ${url}.`), "A: the agent answers with the URL").toBeVisible({
    timeout: 60_000,
  })
  await expect(b.page.getByText(`Got it. I'll clone ${url}.`), "B: the answer syncs").toBeVisible({ timeout: 30_000 })

  // The form is answered everywhere: the value shows, and there is nothing left to send.
  for (const tab of [a, b]) {
    const form = latestForm(tab.page)
    await expect(form.getByLabel("Repository URL"), `${tab.name}: the form shows what was sent`).toHaveValue(url, {
      timeout: 30_000,
    })
    await expect(form.getByLabel("Repository URL")).toBeDisabled()
    await expect(form.getByRole("button", { name: "Clone" }), `${tab.name}: no second send`).toHaveCount(0)
  }
  await a.reload()
  await expect(latestForm(a.page).getByLabel("Repository URL"), "A: still answered after a reload").toHaveValue(url, {
    timeout: 30_000,
  })
})

test.describe("Live forms", () => {
  requires("personalModel", "member", "ownConversation", "liveModel")

  test("Ask with a form: a missing repository URL is requested and its submission continues the real conversation", {
    annotation: { type: "summary", description: "Ask to clone without a URL, fill the agent's form, and see the next reply finish." },
  }, async ({ devices }) => {
    test.setTimeout(420_000)
    const [a] = await devices.open("Repository form")
    const path = ownPlace()?.path ?? "/octocat/Spoon-Knife/tree/main"
    await step("Open the branch conversation", async () => {
      if (new URL(a.page.url()).pathname !== path) await a.page.goto(path)
      await expect(a.page.getByRole("navigation", { name: "Branch", exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(a.page.getByRole("progressbar", { name: "Loading page" })).toHaveCount(0, { timeout: 60_000 })
    })

    // Observe the real engine's write, including worker requests, to avoid finding an earlier run's form.
    const added = a.device.context.waitForEvent("request", {
      predicate: request => new URL(request.url()).pathname === "/api/views" && request.method() === "POST" &&
        request.postDataJSON()?.template === "form",
      timeout: 180_000,
    })
    // The deployment branch keeps earlier runs: require fresh input even when history contains a repository URL.
    const question = `Clone a repository for me. Ask for its URL again, even if I shared one earlier. (${devices.word})`
    await step("Ask to clone a repository without its URL", () => a.askAndWaitTaken(question))
    const created = (await added).postDataJSON() as FormWrite
    const { answerId } = a.asked.find(asked => asked.text === question)!
    expect(created.answerId, "the form belongs to this answer").toBe(answerId)
    const form = a.page.locator(`.conversation-view[data-template="form"][data-view="${created.id}"]`)
    // Use the schema's field name, not the first field whose label happens to mention a repository.
    const schema = created.props.schema
    const document = (schema.schema ?? schema) as { properties?: Record<string, { title?: string; description?: string; format?: string }> }
    const urlFields = Object.entries(document.properties ?? {}).filter(([name, field]) =>
      /url|uri|link/i.test(`${name} ${field.title ?? ""} ${field.description ?? ""} ${field.format ?? ""}`))
    expect(urlFields, "one field asks for a repository URL").toHaveLength(1)
    const urlField = form.getByRole("textbox").and(form.locator(`input[name=${JSON.stringify(urlFields[0]![0])}]`))
    const url = "https://github.com/roninjin10/smithers-github-tests"

    await step("See the URL form and fill it", async () => {
      await expect(form).toBeVisible({ timeout: 30_000 })
      await expect(urlField).toBeVisible()
      await expect(a.conversation.locator(`[data-id="${answerId}"]`)).toHaveAttribute("data-state", "done", { timeout: 180_000 })
      await urlField.fill(url)
    })
    await step("Submit the URL and see the agent continue", async () => {
      const taken = a.page.waitForResponse(response => new URL(response.url()).pathname === "/api/questions" &&
        response.request().method() === "POST" && response.request().postDataJSON()?.source?.viewId === created.id)
      await form.locator('button[type="submit"]').click()
      const response = await taken
      expect(response.status()).toBe(202)
      const submission = response.request().postDataJSON() as { answerId: string; source: { event: string }; data: Record<string, unknown> }
      expect(submission.source.event).toBe("submit")
      expect(Object.values(submission.data)).toContain(url)
      await expect(urlField).toHaveValue(url, { timeout: 30_000 })
      await expect(urlField).toBeDisabled()
      await expect(form.locator('button[type="submit"]')).toHaveCount(0)
      const reply = a.conversation.locator(`[data-id="${submission.answerId}"]`)
      await expect(reply).toHaveAttribute("data-role", "assistant", { timeout: 180_000 })
      await expect(reply).toHaveAttribute("data-state", "done", { timeout: 180_000 })
      await expect(reply.locator('[data-slot="message-response"]')).toHaveAttribute("data-streaming", "false")
      await expect(reply.locator('[data-slot="message-response"]')).toContainText(/\S/)
    })
  })
})
