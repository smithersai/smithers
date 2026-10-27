import { reloadAfter } from "../src/test/reloadTiming"
import { expect, test } from "./devices"
import { faults } from "./faults"
import { github, pollGitHub } from "./github"
import { requires, scratchRepository } from "./target"

for (const delay of [0, 100, 300] as const) {
test(`Create survives reload ${delay} ms after the press`, async ({ devices }) => {
  requires("githubScratch", "member")
  test.setTimeout(180_000)
  const repo = scratchRepository()
  const [person] = await devices.open("Maya")
  const page = person!.page
  const title = `bugbash4-bb5-app-create-${delay}-${devices.word}`
  await page.goto(`/${repo}/issues/new`)
  await page.getByLabel("Title", { exact: true }).fill(title)
  await page.getByLabel("Description", { exact: true }).fill("Durable admission across reload")
  await page.getByRole("button", { name: "Create issue", exact: true }).click()
  await reloadAfter(delay, () => page.reload())
  await expect.poll(async () => /\/issues\/\d+$/.test(new URL(page.url()).pathname) || await page.getByRole("button", { name: "Retry", exact: true }).isVisible(), { timeout: 90_000 }).toBe(true)
  if (await page.getByRole("button", { name: "Retry", exact: true }).isVisible()) await page.getByRole("button", { name: "Retry", exact: true }).click()
  await expect(page).toHaveURL(/\/issues\/\d+$/, { timeout: 90_000 })
  const number = new URL(page.url()).pathname.split("/").at(-1)!
  await expect(page.getByRole("heading", { name: `${title} #${number}`, exact: true })).toBeVisible()
  const issues = await pollGitHub(() => github<Array<{ title: string }>>(page, `/repos/${repo}/issues?state=all&per_page=100`), (rows) => rows.some((row) => row.title === title))
  expect(issues.filter((row) => row.title === title)).toHaveLength(1)
})

}

test("an offline Create remains Requested through reload", async ({ devices }) => {
  requires("githubScratch", "member")
  const repo = scratchRepository()
  const [person] = await devices.open("Maya")
  const page = person!.page
  await page.goto(`/${repo}/issues/new`)
  await page.getByLabel("Title", { exact: true }).fill(`bugbash4-bb5-app-offline-${devices.word}`)
  await person!.offline()
  await page.getByRole("button", { name: "Create issue", exact: true }).click()
  await expect(page).toHaveURL(/\?write=/)
  await expect(page.getByRole("status").filter({ hasText: /^Requested$/ })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("status").filter({ hasText: /^Requested$/ })).toBeVisible()
  await expect(page.getByText("Creating issue…", { exact: true })).toHaveCount(0)
})

test("a write URL unavailable on this device recovers to Issues", async ({ devices }) => {
  requires("githubScratch", "member")
  const repo = scratchRepository()
  const [person] = await devices.open("Maya")
  const page = person!.page
  await page.goto(`/${repo}/issues/new?write=${crypto.randomUUID()}`)
  await expect(page.getByRole("heading", { name: "Request unavailable", exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText("Requested", { exact: true })).toHaveCount(0)
  await page.getByRole("link", { name: "Issues", exact: true }).last().click()
  await expect(page).toHaveURL(new RegExp(`/${repo}/issues$`))
})


test("comment admission survives a refused engine join", async ({ devices }) => {
  requires("faults", "syncedScratch", "member")
  const repo = scratchRepository()
  const [person] = await devices.openFaulty("Maya")
  const page = person!.page
  const issues = await github<Array<{ number: number; pull_request?: unknown }>>(page, `/repos/${repo}/issues?state=open&per_page=100`)
  const issue = issues.find((row) => row.pull_request === undefined)
  expect(issue).toBeDefined()
  await page.goto(`/${repo}/issues/${issue!.number}?faults`)
  await faults(page).engine.refuseStarts("issue/comment")
  const comment = `bugbash4-bb5-app-comment-engine-${devices.word}`
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill(comment)
  await page.getByRole("button", { name: "Comment", exact: true }).click()
  await page.reload()
  const posted = await pollGitHub(() => github<Array<{ body: string }>>(page, `/repos/${repo}/issues/${issue!.number}/comments?per_page=100`), (rows) => rows.some((row) => row.body.startsWith(comment)))
  expect(posted.filter((row) => row.body.startsWith(comment))).toHaveLength(1)
})

for (const delay of [0, 100, 300] as const) {
  test(`comment survives reload ${delay} ms after pressing Comment`, async ({ devices }) => {
    requires("githubScratch", "member")
    test.setTimeout(180_000)
    const repo = scratchRepository()
    const [person] = await devices.open("Maya")
    const page = person!.page
    const issues = await github<Array<{ number: number; pull_request?: unknown }>>(page, `/repos/${repo}/issues?state=open&per_page=100`)
    const issue = issues.find((row) => row.pull_request === undefined)
    expect(issue).toBeDefined()
    await page.goto(`/${repo}/issues/${issue!.number}`)
    const body = `bugbash4-bb5-app-comment-${delay}-${devices.word}`
    await page.getByRole("textbox", { name: "Comment", exact: true }).fill(body)
    await page.getByRole("button", { name: "Comment", exact: true }).click()
    await reloadAfter(delay, () => page.reload())
    const posted = await pollGitHub(() => github<Array<{ body: string }>>(page, `/repos/${repo}/issues/${issue!.number}/comments?per_page=100`), (rows) => rows.some((row) => row.body.startsWith(body)))
    expect(posted.filter((row) => row.body.startsWith(body))).toHaveLength(1)
    await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toHaveValue("")
  })
}

for (const delay of [0, 100, 300] as const) {
  test(`a slash comment survives reload ${delay} ms after Enter`, async ({ devices }) => {
    requires("githubScratch", "member")
    test.setTimeout(180_000)
    const repo = scratchRepository()
    const [person] = await devices.open("Maya")
    const page = person!.page
    const issues = await github<Array<{ number: number; pull_request?: unknown }>>(page, `/repos/${repo}/issues?state=open&per_page=100`)
    const issue = issues.find((row) => row.pull_request === undefined)
    expect(issue).toBeDefined()
    const body = `bugbash4-bb5-app-slash-comment-${delay}-${devices.word}`
    await person!.openComposer()
    await person!.composer.fill(`/comment ${repo} ${issue!.number} ${body}`)
    await person!.composer.press("Enter")
    await reloadAfter(delay, () => page.reload())
    const posted = await pollGitHub(() => github<Array<{ body: string }>>(page, `/repos/${repo}/issues/${issue!.number}/comments?per_page=100`), (rows) => rows.some((row) => row.body.startsWith(body)))
    expect(posted.filter((row) => row.body.startsWith(body))).toHaveLength(1)
  })
}
