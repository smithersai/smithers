import { questionIn } from "./messages"
import { allServerRows, expect, type Row, test } from "./devices"
import { field, type LogRecord, LogTail } from "./logs"
import { partly, requires } from "./target"

// `repo/clone` end to end (docs/features/repo.md#flows): a person's `/clone owner/name` and the agent asked to clone run
// the same flow on the browser's engine, whose step asks RepoApi (`POST /api/repos`); RepoApi admits it and starts the
// durable `repo/Clone`. Real app, engine worker, Worker, Postgres, Electric, model, GitHub and Code Storage. Cloning is
// idempotent, so a repository a run already cloned answers `existing` and opens as before; the first run clones. A
// clone is a Member's request (worker/RepoApi.ts `canClone`), and opening ready waits on the remote flow
// (worker/RepoApi.ts `start`, worker/flows/RepoClone.ts).

requires("codeStorage", "member")

/** Typing a person can follow in the video. */
const typing = { delay: 60 }

/** The engine worker's `repo.clone` lines ChatApi relayed, as their outcomes. */
const clones = (records: Array<LogRecord>) =>
  records
    .filter((record) => record.message === "repo.clone" && field(record, "otlp.signal") === "logs")
    .map((record) => field(record, "outcome"))

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

test("clone by slash: /clone octocat/Hello-World runs repo/clone, and the repository opens ready", { annotation: { type: "summary", description: "/clone clones a repository, and it opens ready." } }, async ({ devices }) => {
  const logs = partly("localLogs") ? await LogTail.start() : undefined
  const [a] = await devices.open("A")
  await expect(a.chatButton).toBeVisible({ timeout: 30_000 })
  await a.openComposer()
  await a.composer.pressSequentially("/clone octocat/Hello-World", typing)
  await a.composer.press("Enter")
  await expect(a.composer).toHaveValue("")
  // Nothing goes to the agent: the line is the flow's.
  await expect(questionIn(a.conversation, "/clone")).toHaveCount(0)
  if (logs !== undefined) {
    await expect.poll(async () => clones((await logs.records()).browser), { timeout: 60_000 }).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(started|existing)$/)]),
    )
  }
  // Its one file, README, lists at the default branch, master.
  await a.page.goto("/octocat/Hello-World")
  await expect(a.page.getByRole("link", { name: "README", exact: true }).first()).toBeVisible({ timeout: 120_000 })
  await expect(a.page.getByRole("button", { name: "master", exact: true })).toBeVisible()
})

test("clone by the agent: asked to clone octocat/Spoon-Knife, it calls repo/clone", { annotation: { type: "summary", description: "Asked to clone a repository, the agent runs the same clone flow." } }, async ({ devices, request }) => {
  // It asks: in a deployment, only in the test account's own conversation (e2e/target.ts).
  requires("personalModel", "ownConversation")
  const word = devices.word
  const [a] = await devices.open("A")
  const question = `Clone octocat/Spoon-Knife, then reply with the word clone-${word}.`
  await a.askAndWaitTaken(question)
  await expect
    .poll(async () => answerRow(await allServerRows(request), question)?.status, { timeout: 90_000 })
    .toBe("done")
  expect(steps(answerRow(await allServerRows(request), question), "repo/clone")).toContain("done")
  // Cloned, not GitHub's preview: the branch picker shows only for a ready copy.
  await a.page.goto("/octocat/Spoon-Knife")
  await expect(a.page.getByRole("button", { name: "main", exact: true })).toBeVisible({ timeout: 120_000 })
  await expect(a.page.getByText("Well hello there!")).toBeVisible()
})
