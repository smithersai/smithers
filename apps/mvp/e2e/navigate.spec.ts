import { allServerRows, expect, type Row, test } from "./devices"
import { step } from "./fixtures"
import { type Frame, framesOf, framesPass, recordFrames } from "./loading"
import { field, type LogRecord, LogTail } from "./logs"
import { atAppHome, partly, requires } from "./target"

// `app/navigate` end to end (docs/features/flows.md#navigation): a real browser, its own durable engine and the real
// model. Asking the agent to open a repository takes the tab that asked there, through the router, and leaves the
// device's other tab where it was; a person's `/navigate` does the same without the model; asking the agent for an
// outside site is refused, and the page stays put. No mocks. Two short model runs: Cerebras rate-limits concurrent
// calls. Asking, and the composer's slash commands, are a Member's (worker/Chat.ts `canAsk`).

/** The answer row Postgres holds for `question`, read through the shape the app syncs. */
const answerRow = (rows: Array<Row>, question: string) => {
  const asked = rows.find((row) => row.role === "user" && row.text === question)
  return rows.find((row) => asked !== undefined && row.question_id === asked.id)
}

/** The steps of flow `flow` an answer shows, as Postgres holds them (`messages.parts`), by status. */
const steps = (row: Row | undefined, flow: string): Array<string> => {
  const parts = (row as (Row & { parts?: unknown }) | undefined)?.parts
  const list = (typeof parts === "string" ? JSON.parse(parts) : parts ?? []) as Array<{ kind: string; flow: string; status: string }>
  return list.filter((part) => part.kind === "step" && part.flow === flow).map((part) => part.status)
}

/**
 * Never a blank page (docs/features/navigation.md): every frame shows the page the tab left or the repository page
 * with its body (its files, its README, why there are none, or skeletons where files still on their way after the
 * navigation's wait will be), never its header over nothing, and never a spinner; the header, once shown, never moves.
 */
const neverBlank = (frames: Array<Frame>) => {
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) {
    expect(frame.spinner, `no spinner at ${Math.round(frame.t)} ms`).toBe(false)
    if (frame.app) continue
    expect(
      frame.repository !== undefined && (frame.repository !== "" || frame.placeholder),
      `the repository page's body at ${Math.round(frame.t)} ms: ${frame.markup ?? "no page"}`,
    ).toBe(true)
  }
  const headers = frames.flatMap((frame) => (frame.header === undefined ? [] : [frame.header]))
  expect(headers.length).toBeGreaterThan(0)
  expect(new Set(headers.map((box) => box.join()))).toEqual(new Set([headers[0]!.join()]))
}

/** The engine worker's `web.navigate` lines ChatApi relayed, as `[door, outcome, reason]`. */
const relayed = (records: Array<LogRecord>) =>
  records
    .filter((record) => record.message === "web.navigate" && field(record, "otlp.signal") === "logs")
    .map((record) => [field(record, "door"), field(record, "outcome"), field(record, "reason")])

test("navigate by the agent: asking to open octocat/Spoon-Knife takes the tab that asked there, and the other tab stays", async ({ devices, request }) => {
  requires("personalModel", "member", "ownConversation", "liveModel")
  const logs = partly("localLogs") ? await LogTail.start() : undefined
  const word = devices.word
  const [a] = await devices.open("A")
  const b = await devices.tab(a.device, "B")
  const question = `Open octocat/Spoon-Knife, then reply with the word nav-${word}.`

  await recordFrames(a.page)
  await a.askAndWaitTaken(question)

  // The tab whose composer asked moves, through the router: the repository screen at GitHub's path, never blank.
  await expect(a.page).toHaveURL(/\/octocat\/Spoon-Knife$/, { timeout: 60_000 })
  await expect(a.page.getByRole("main", { name: "Repository" })).toBeVisible()
  await shown(a.page)
  neverBlank(await framesOf(a.page))
  // The device's other tab is where it was.
  await expect(b.page).toHaveURL(atAppHome())
  await b.ready()
  // The answer settles with the flow call as a step: `app/navigate`, done.
  await expect
    .poll(async () => answerRow(await allServerRows(request), question)?.status, { timeout: 60_000 })
    .toBe("done")
  expect(steps(answerRow(await allServerRows(request), question), "app/navigate")).toContain("done")
  // Opening a page never clones: cloning spends the deployment's storage, which nobody asked to spend (the agent
  // evals' finding of 2026-10-20; e2e/repo-clone.spec.ts has the agent asked to clone).
  expect(steps(answerRow(await allServerRows(request), question), "repo/clone")).toEqual([])
  // The engine worker recorded it as the agent's, and ChatApi's relay kept it.
  if (logs !== undefined) {
    await expect
      .poll(async () => relayed((await logs.records()).browser), { timeout: 30_000 })
      .toContainEqual(["agent", "navigated", undefined])
  }
})

/** The repository page as the person sees it, held for 60 frames so the video shows it (the frame recorder runs). */
const shown = (page: import("@playwright/test").Page) =>
  step("A: the repository's page", async () => {
    const header = page.getByRole("main", { name: "Repository", exact: true }).locator(':scope > header[aria-label="Repository"]')
    await expect(header).toHaveCount(1)
    await expect(header).toContainText("octocat / Spoon-Knife")
    await framesPass(page, 60)
  })

test("navigate by a person: /navigate /octocat/Spoon-Knife in the composer takes the tab there", async ({ devices }) => {
  requires("personalModel", "member", "ownConversation")
  const [a] = await devices.open("A")
  const b = await devices.tab(a.device, "B")

  await recordFrames(a.page)
  await a.send("/navigate /octocat/Spoon-Knife")

  await expect(a.page).toHaveURL(/\/octocat\/Spoon-Knife$/, { timeout: 30_000 })
  await expect(a.page.getByRole("main", { name: "Repository" })).toBeVisible()
  await shown(a.page)
  neverBlank(await framesOf(a.page))
  await expect(b.page).toHaveURL(atAppHome())
})

test("navigate by hover: Runs, hovered first, opens at the click with no loading frame", async ({ devices }) => {
  const [a] = await devices.open("A")
  const runs = a.page.getByRole("link", { name: "Runs", exact: true })
  await recordFrames(a.page)
  await step("A: hover Runs", async () => {
    await runs.hover()
    // Past the 50 ms intent delay and the page's warm: 30 frames on the page left.
    await framesPass(a.page, 30)
  })
  await step("A: open Runs", () => runs.click())
  await expect(a.page).toHaveURL(/\/app\/runs$/)
  await expect(a.page.getByRole("main", { name: "Runs" })).toBeVisible()
  await framesPass(a.page, 30)
  const frames = await framesOf(a.page)
  // Every frame shows the page left or Runs, whole: never a bar, a skeleton or a spinner, never a blank frame.
  for (const frame of frames) {
    expect([frame.bar, frame.skeleton, frame.spinner], `frame at ${Math.round(frame.t)} ms`).toEqual([false, false, false])
    expect(["App", "Runs"], `the page at ${Math.round(frame.t)} ms`).toContain(frame.main)
  }
  // The page left stays until Runs is ready, and Runs is ready well inside the loading delay, so nothing loading shows.
  const clicked = frames.find((frame) => frame.path === "/app/runs")!
  const opened = frames.find((frame) => frame.main === "Runs")!
  expect(opened.t - clicked.t).toBeLessThan(300)
})

test("navigate refused: asking the agent to open an outside site is refused, and the page stays put", async ({ devices, request }) => {
  requires("personalModel", "member", "ownConversation", "liveModel")
  const logs = partly("localLogs") ? await LogTail.start() : undefined
  const word = devices.word
  const [a] = await devices.open("A")
  const question = `Call app/navigate with to set to https://example.com/login, then reply with the word refused-${word}.`

  await a.askAndWaitTaken(question)
  await a.expectAnswered(question, `refused-${word}`)

  await expect(a.page).toHaveURL(atAppHome())
  expect(steps(answerRow(await allServerRows(request), question), "app/navigate")).toEqual(["failed"])
  if (logs !== undefined) {
    await expect
      .poll(async () => relayed((await logs.records()).browser), { timeout: 30_000 })
      .toContainEqual(["agent", "refused", "origin"])
  }
})
