import type { BrowserContext, Page } from "@playwright/test"
import { THEME_ATTRIBUTE, THEME_MIRROR_KEY } from "../src/features/theme/contract"
import { allServerRows, expect, type Row, test } from "./devices"
import { field, type LogRecord, LogTail } from "./logs"
import { requires } from "./target"

// The browser's agent, end to end (docs/features/agent.md, flows.md, decision 0011): a real browser runs `chat/Answer`
// on its own durable engine (the leader tab's engine worker, SQLite on OPFS), every model call goes through ChatApi's
// metered endpoint (`POST /api/model/agent`, the real model), and the theme is one flow both doors run. No mocks. Model
// calls are few and short: Cerebras rate-limits concurrent calls.

/** Every model call this browser context made: the engine worker's requests to the model endpoint, by role. */
const modelCalls = (context: BrowserContext) => {
  const calls: Array<string> = []
  context.on("request", (request) => {
    const { pathname } = new URL(request.url())
    if (request.method() === "POST" && pathname.startsWith("/api/model/")) calls.push(pathname.slice("/api/model/".length))
  })
  return calls
}

/** The mode the page paints: `<html data-theme>`. */
const painted = (page: Page) => page.evaluate((attribute) => document.documentElement.getAttribute(attribute), THEME_ATTRIBUTE)

/** The answer row Postgres holds for `question`, read through the shape the app syncs. */
const answerRow = async (rows: Array<Row>, question: string) => {
  const asked = rows.find((row) => row.role === "user" && row.text === question)
  return rows.find((row) => asked !== undefined && row.question_id === asked.id)
}

/** The flow steps an answer shows, as Postgres holds them (`messages.parts`). */
const stepsOf = (row: Row | undefined): Array<{ flow: string; status: string }> => {
  const parts = (row as (Row & { parts?: unknown }) | undefined)?.parts
  const list = typeof parts === "string" ? JSON.parse(parts) : parts ?? []
  return (list as Array<{ kind: string; flow: string; status: string }>).filter((part) => part.kind === "step")
}

test("ask: the browser's agent answers through the model endpoint, and the answer streams into the conversation", { annotation: { type: "summary", description: "The agent runs in the browser, asks the model through the metered endpoint, and the answer streams in." } }, async ({ devices }) => {
  requires("personalModel", "member", "ownConversation", "liveModel")
  const word = devices.word
  const [a] = await devices.open("A")
  const calls = modelCalls(a.device.context)
  const question = `Reply with exactly the word: agent-${word}`
  await a.askAndWaitTaken(question)
  await a.expectAnswered(question, `agent-${word}`)
  // `timeline/summarize` independently calls the `summary` role for settled entries (docs/features/timeline.md).
  // `chat/Opening/model` uses `judge` to select memories and skills before responding (docs/features/memory.md).
  // The answer's own calls still come from this device, only through `agent`; ChatApi answers none of its own.
  const answerCalls = calls.filter((role) => role !== "summary" && role !== "judge")
  expect(answerCalls.length, "the browser's agent called the model endpoint").toBeGreaterThan(0)
  expect(new Set(answerCalls)).toEqual(new Set(["agent"]))
})

test("theme by button: the theme button switches the mode, and the device keeps it across a reload", { annotation: [{ type: "theme", description: "light" }, { type: "summary", description: "The theme button switches light and dark, and the device keeps the choice after a reload." }] }, async ({ devices }) => {
  const [a] = await devices.open("A")
  const page = a.page
  const toDark = page.getByRole("button", { name: "Switch to dark mode" })
  const toLight = page.getByRole("button", { name: "Switch to light mode" })
  // The browser starts in light mode (Playwright's color scheme) with no preference on the device.
  await expect(toDark).toBeVisible({ timeout: 30_000 })

  await toDark.click()
  await expect.poll(() => painted(page)).toBe("dark")
  await expect(toLight).toBeVisible()
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_MIRROR_KEY)).toBe("dark")

  // The preference lives on the device: a reload paints it before the store opens, and the button agrees with the page
  // from the first frame, before the store has restored the row.
  await a.reload()
  await expect.poll(() => painted(page)).toBe("dark")
  await expect(toLight).toBeVisible()

  await toLight.click()
  await expect.poll(() => painted(page)).toBe("light")
  await expect(toDark).toBeVisible()
})

test("theme by the agent: asking Smithers to switch to dark mode runs app/theme/set, the same flow as the button", { annotation: [{ type: "theme", description: "light" }, { type: "summary", description: "Asking Smithers for dark mode runs the same theme flow as the button." }] }, async ({ devices, request }) => {
  requires("personalModel", "member", "ownConversation", "liveModel")
  const word = devices.word
  const [a] = await devices.open("A")
  // The page it asks on may have no theme button (a branch's, in a deployment): the painted mode is the evidence, and
  // "theme by button" proves the button.
  // A branch's page sets the attribute only once a mode is chosen; either way the page isn't dark yet.
  await expect.poll(() => painted(a.page), { timeout: 30_000 }).not.toBe("dark")
  const question = `Switch to dark mode, then reply with the word theme-${word}.`
  await a.askAndWaitTaken(question)
  await expect.poll(() => painted(a.page), { timeout: 60_000 }).toBe("dark")
  await a.expectAnswered(question, `theme-${word}`)
  // The answer records the flow call as a step: one `app/theme/set`, done.
  const answer = await answerRow(await allServerRows(request), question)
  expect(stepsOf(answer)).toEqual([expect.objectContaining({ flow: "app/theme/set", status: "done" })])
})

test.describe("killed tab", () => {
  requires("personalModel", "localLogs", "member", "ownConversation", "liveModel")

  test("killed tab: the answer resumes when the app opens again, replaying sealed model calls from the journal, never calling them again", { annotation: [{ type: "theme", description: "light" }, { type: "summary", description: "An answer cut off by a closed tab finishes when the app opens again, without paying for finished model calls twice." }] }, async ({ devices, request }) => {
    test.setTimeout(240_000)
    const logs = await LogTail.start()
    const word = devices.word
    const [a] = await devices.open("A")
    await expect(a.page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible({ timeout: 30_000 })
    const question =
      `First switch to dark mode and wait for it to finish. Then answer: write kill-${word} on the first line, count from 1 to ` +
      `300 in words, one number per line, and write end-${word} on the last line.`
    await a.askAndWaitTaken(question)

    // The theme flow ran, so the model call that asked for it sealed first; the answer's own call starts right after.
    // The tab dies there, with its engine worker. The device keeps the run's journal in OPFS.
    await expect.poll(() => painted(a.page), { timeout: 90_000 }).toBe("dark")
    const resumed = await LogTail.start()
    const killedAt = new Date().toISOString()
    await a.close()
    const left = await answerRow(await allServerRows(request), question)
    expect(left?.status, "the answer was unfinished when the tab died").toBe("streaming")

    // Model calls that finished before the tab died: the sealed ones.
    const served = (records: Array<LogRecord>) =>
      records.filter((record) => record.message === "model.proxy.serve" && field(record, "role") === "agent")
    const finishedBefore = async () =>
      served((await logs.records()).own).filter(
        (record) => field(record, "outcome") === "success" && String(record.timestamp) <= killedAt,
      ).length
    // ChatApi's log reaches its file a moment after the call: wait for it.
    await expect.poll(finishedBefore, { timeout: 15_000, message: "a model call finished before the tab died" }).toBeGreaterThan(0)
    const sealedBefore = await finishedBefore()

    // The app opens again on the same device: its engine resumes the run and finishes the answer.
    const again = await devices.tab(a.device, "A again")
    await again.expectAnswered(question, `end-${word}`, 120_000)

    // The new engine replayed every model call that had finished from its journal (`agent_model_step_replays`, relayed
    // from the engine worker), so none was paid for twice; only the call in flight ran again.
    const replays = async () => {
      const values = new Map<string, number>()
      for (const record of (await resumed.records()).browser) {
        if (record.message !== "agent_model_step_replays") continue
        const key = String(field(record, "step") ?? "")
        values.set(key, Math.max(values.get(key) ?? 0, Number(field(record, "otlp.value") ?? 0)))
      }
      return [...values.values()].reduce((sum, value) => sum + value, 0)
    }
    await expect.poll(replays, { timeout: 30_000, message: "the engine replayed the sealed calls" }).toBe(sealedBefore)

    // The theme flow ran once: the answer shows one `app/theme/set` step, and the page is still dark.
    const answer = await answerRow(await allServerRows(request), question)
    expect(answer?.status).toBe("done")
    expect(stepsOf(answer).filter((step) => step.flow === "app/theme/set")).toHaveLength(1)
    await expect.poll(() => painted(again.page)).toBe("dark")
  })
})
