import { expect, type Page, type TestInfo } from "@playwright/test"
import { recordActions, step, themeOf, writeManifest } from "./fixtures"
import { cleanUp, type Runner, startRunner } from "./runner"
import { configureStack, stackChange } from "./stackWrites"
import { requires, stackRepository } from "./target"
import { strictTest as test } from "./watch"

// Independent lanes, end to end (decision 0135, docs/features/todos.md#lanes): a repository runs many TODOs at once,
// each independent of the rest unless it names the TODO it stacks on. Everything is real: the stack route, its one
// writer, Postgres, Electric and the browser's stack page.
//
// - "after" runs wherever the stack route does, on the writable stack (`stackRepository()`) where the account is an
//   Admin: it sets ten independent lanes, commits two TODOs, the second after the first, and the stack shows it
//   stacked: `After T<n>` on its row and page. A commit after a TODO that isn't open is refused. Locally nothing runs
//   a TODO (no GitHub App), so both stay Queued; in a deployment the first may start, and both are dropped after.
// - "ten at once" runs the TODOs on an external agent (decision 0136): the spec starts a runner of ten with the ACP
//   test agent (e2e/runner.ts), whose prompts are its script. Ten work at once, one fails (it asks for no change), nine
//   reach In review with their pull requests, and the TODO after the first waits for it, then runs on its branch. It
//   writes to GitHub, so it needs the App on a scratch repository the test account administers and a mirror of it
//   (`agentRunner`), and never merges.

const started = new WeakMap<TestInfo, number>()

test.beforeEach(async ({ page }, info) => {
  started.set(info, Date.now())
  await page.emulateMedia({ colorScheme: themeOf(info) })
  await recordActions(page, info, "Ada")
})

test.afterEach(async ({}, info) => {
  await writeManifest(info, "flow.json", started.get(info) ?? Date.now(), [{ name: "Ada", video: "video.webm", openedAt: 0 }])
})

const change = stackChange

/** Commits a TODO titled `title`; answers its number. */
const commit = async (page: Page, repository: string, title: string, prompt: string, after?: number | null) => {
  const answer = await change(page, repository, { op: "commit", title, prompt, ...(after === undefined ? {} : { after }) })
  expect(answer, `commit ${title}`).toMatchObject({ status: 202, body: { outcome: "committed" } })
  return answer.body.number!
}

const configure = configureStack

/** The stack page's rows. */
const rows = (page: Page, repository: string) =>
  page.getByRole("region", { name: `${repository} stack` }).locator("[data-slot=issues-row]")

/** The row of the TODO titled `title`. */
const row = (page: Page, repository: string, title: string) =>
  rows(page, repository).filter({ has: page.getByRole("link", { name: title, exact: true }) })

/** How many rows of TODOs with `word` in their title are in state `kind`. */
const counted = (page: Page, repository: string, word: string, kind: string) =>
  rows(page, repository).filter({ hasText: word }).and(page.locator(`[data-status=${kind}]`)).count()

test("todos-independent-after: an Admin sets independent lanes; a TODO after another says so and waits for it", {
  annotation: { type: "summary", description: "Ten independent lanes; T2 stacks on T1 by choice, and its row and page say After T1." },
}, async ({ page }) => {
  requires("writableStack", "stackAdmin")
  test.setTimeout(180_000)
  const repository = stackRepository()
  const word = `i${Date.now().toString(36)}`
  const numbers: Array<number> = []
  try {
    await step("Set ten independent lanes", async () => {
      await page.goto(`/${repository}/stack`)
      await expect(page.getByRole("region", { name: `${repository} stack` })).toBeVisible({ timeout: 60_000 })
      expect(await configure(page, repository, 10, "independent")).toMatchObject({ status: 202, body: { outcome: "configured" } })
    })
    await step("Commit a TODO, and one after it", async () => {
      numbers.push(await commit(page, repository, `First ${word}`, `Add the line ${word} to NOTES.md.`))
      numbers.push(await commit(page, repository, `Second ${word}`, `Build on the first: ${word}.`, numbers[0]!))
      // A TODO can only stack on an open one.
      expect(await change(page, repository, { op: "commit", title: `Stray ${word}`, prompt: "x", after: 2_000_000_000 }))
        .toMatchObject({ status: 409, body: { code: "after_not_open" } })
    })
    const [first, second] = numbers as [number, number]
    await step("The stack shows the second after the first", async () => {
      await expect(row(page, repository, `Second ${word}`)).toContainText(`After T${first}`, { timeout: 60_000 })
      await expect(row(page, repository, `First ${word}`)).not.toContainText("After T")
      await row(page, repository, `Second ${word}`).getByRole("link", { name: `Second ${word}` }).click()
      const article = page.getByRole("article", { name: new RegExp(`Second ${word}`) })
      await expect(article).toContainText(`T${second}`, { timeout: 60_000 })
      await page.getByRole("link", { name: `After T${first}` }).click()
      await expect(page).toHaveURL(new RegExp(`/${repository}/stack/${first}$`))
      await expect(page.getByRole("article", { name: new RegExp(`First ${word}`) })).toBeVisible({ timeout: 60_000 })
    })
  } finally {
    for (const number of numbers.reverse()) await change(page, repository, { op: "drop", number })
    await configure(page, repository, 1, "stacked")
  }
})

test("todos-independent-run: ten TODOs work at once; one fails, nine publish, and one after another waits for it", {
  annotation: { type: "summary", description: "Ten TODOs Working at once; one fails, nine reach review, and the one after T1 runs only once T1 is in review." },
}, async ({ page }) => {
  requires("agentRunner")
  test.setTimeout(30 * 60_000)
  const repository = process.env.E2E_FACTORY_REPOSITORY ?? ""
  const word = `l${Date.now().toString(36)}`
  const numbers: Array<number> = []
  let runner: Runner | undefined
  try {
    await step("Start a runner of ten, set ten independent lanes and commit ten TODOs, one asking for no change", async () => {
      await page.goto(`/${repository}/stack`)
      await expect(page.getByRole("region", { name: `${repository} stack` })).toBeVisible({ timeout: 60_000 })
      runner = await startRunner(page, repository, word, 10)
      expect(await configure(page, repository, 10, "independent")).toMatchObject({ status: 202 })
      // Each agent works a minute first, so all ten are Working together before the first publishes.
      const work = "run `sleep 60`"
      for (let index = 1; index <= 9; index++) {
        numbers.push(await commit(page, repository, `Lane ${index} ${word}`, `${work}\nadd the line \`${word}-${index}\` to \`lanes/${word}-${index}.md\``))
      }
      numbers.push(await commit(page, repository, `Nothing ${word}`, `${work}\nMake no change to any file.`))
    })
    await step("Ten work at once", async () => {
      await expect.poll(() => counted(page, repository, word, "running"), { timeout: 120_000 }).toBe(10)
    })
    const after = await step("A TODO after the first waits for it", async () => {
      const number = await commit(page, repository, `After ${word}`, `add the line \`${word}-after\` to \`lanes/${word}-1.md\``, numbers[0]!)
      numbers.push(number)
      await expect(row(page, repository, `After ${word}`)).toHaveAttribute("data-status", "queued", { timeout: 60_000 })
      await expect(row(page, repository, `After ${word}`)).toContainText(`After T${numbers[0]}`)
      return number
    })
    await step("One fails, nine reach review, and the one after the first runs on it", async () => {
      await expect.poll(() => counted(page, repository, word, "failed"), { timeout: 20 * 60_000, intervals: [10_000] }).toBe(1)
      await expect(row(page, repository, `Nothing ${word}`)).toHaveAttribute("data-status", "failed")
      await expect.poll(() => counted(page, repository, word, "in_review"), { timeout: 20 * 60_000, intervals: [10_000] }).toBe(10)
      expect(after).toBe(numbers[10])
      await row(page, repository, `After ${word}`).getByRole("link", { name: `After ${word}` }).click()
      await expect(page.getByRole("link", { name: `After T${numbers[0]}` })).toBeVisible({ timeout: 60_000 })
    })
  } catch (error) {
    await runner?.attach()
    throw error
  } finally {
    const api = { request: runner?.api ?? page.request }
    await cleanUp(
      ...numbers.reverse().map((number) => () => change(api, repository, { op: "drop", number })),
      () => configure(api, repository, 1, "stacked"),
      async () => { await runner?.stop() },
    )
  }
})
