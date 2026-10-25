import { digestSync } from "@smthrs/crypto"
import { renderSource, SOURCE_PATH } from "../src/features/flows-ui/source"
import { expect, test } from "./devices"
import { requires, scriptedAgent } from "./target"

requires("member", "localServer")

for (const width of [1280, 390]) {
  test(`toasts at ${width}px: Save stays clickable with several live notices`, async ({ devices }) => {
    const [a] = await devices.open("Editor")
    const page = a.page
    await page.setViewportSize({ width, height: 800 })
    const name = `toast-${devices.word}`
    const source = renderSource({ name, description: "Toast regression", instructions: "Answer ready.", flows: [] })
    const draftId = crypto.randomUUID()
    const request = page.request
    const post = async (path: string, data: unknown) => {
      const response = await request.post(path, { data })
      expect(response.ok(), `${path}: ${await response.text()}`).toBe(true)
      return response
    }
    await post(`/api/flow-drafts/${draftId}`, {
      scope: "person", round: 0, request: "Answer ready.", name, status: "ready", summary: "Toast regression",
      files: [{ path: SOURCE_PATH, text: source }], checks: [{ check: "parses", ok: true }],
      questions: [], failure: null, flowId: null,
    })
    const saved = await post("/api/flows/save", { draftId, name, description: "Toast regression", source, digest: digestSync(source) })
    const runIds: Array<string> = []
    try {
      await test.step("Open several live notices", async () => {
        for (let i = 0; i < 5; i++) {
          const id = crypto.randomUUID(), answerId = crypto.randomUUID()
          await post("/api/questions", { id, answerId, text: `Use the sandbox tools on this branch ${name} ${i}` })
          runIds.push(answerId)
          await post(`/api/runs/${answerId}`, { status: "working" })
        }
      })
      await page.goto(`/app/flows/code/${name}`)
      const stack = page.getByRole("region", { name: "Smithers", exact: true })
      await expect(stack.locator('[data-slot="toast"]')).toHaveCount(3, { timeout: 30_000 })
      await expect(stack.getByRole("button", { name: /^\+\d+$/ })).toHaveCount(0)
      const code = page.getByRole("textbox", { name: "Code", exact: true })
      await expect(code).toHaveValue(source)
      await code.fill(`${source}\n`)
      if (width === 390) {
        await test.step("Click the lower left of the code", async () => {
          await page.getByRole("button", { name: "Save", exact: true }).focus()
          const box = await code.boundingBox()
          if (box === null) throw new Error("Code has no visible bounds")
          await page.mouse.click(box.x + 16, Math.min(650, box.y + box.height - 16))
          await expect(code).toBeFocused()
        })
      }
      await test.step("Save at the foot of the content column", async () => {
        const save = page.getByRole("button", { name: "Save", exact: true })
        await save.evaluate((button) => button.scrollIntoView({ block: "end" }))
        await save.click({ timeout: 5_000 })
        await expect(save).toBeDisabled()
        await expect.poll(async () => (await (await request.get(`/api/flows/source?name=${name}`)).json()).revision, { timeout: 30_000 })
          .toBe(2)
      })
    } finally {
      for (const id of runIds) {
        await post(`/api/answers/${id}`, { status: "failed", failure: "unfinished" })
        await post("/api/notifications/ack", { subject: `run:${id}`, version: 2, act: "dismiss" })
      }
      const flow = await saved.json()
      if (flow.flowId) await post(`/api/flows/${flow.flowId}/delete`, {})
    }
  })
}

test("stopped work: its live notice settles from the engine cancellation", async ({ devices }) => {
  requires("scriptedAgent")
  const [a] = await devices.open("Worker")
  await a.page.goto(scriptedAgent("needs-you"))
  await a.ready()
  const question = `Use the sandbox tools on this branch ${devices.word}`
  await a.askAndWaitTaken(question)
  const answerId = a.asked.find((row) => row.text === question)!.answerId
  try {
    await a.page.reload()
    await a.ready()
    await a.page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Runs", exact: true }).click()
    await a.page.locator(`a[href="/app/runs/${answerId}"]`).click()
    const notice = a.page.locator(`[data-slot="toast"][data-run="${answerId}"]`)
    await expect(notice).toBeVisible({ timeout: 60_000 })
    await a.page.getByRole("button", { name: "Stop", exact: true }).click()
    await expect(a.page.locator('[data-slot="run-header"] [role="status"]')).toContainText("Stopped", { timeout: 60_000 })
    await expect(notice).toHaveCount(0, { timeout: 30_000 })
    await a.page.goto("/app")
    await expect(a.page.locator(`[id="${answerId}"]`)).toContainText("Couldn't answer")
  } finally {
    await a.page.request.post(`/api/answers/${answerId}`, { data: { status: "failed", failure: "unfinished" } })
    await a.page.request.post("/api/notifications/ack", { data: { subject: `run:${answerId}`, version: 3, act: "dismiss" } })
  }
})
