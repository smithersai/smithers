// The issue-tracking proof (docs/features/work-links.md#the-proof), against a deployment, on a private repository
// seeded with our real tracking records (apps/mvp/ops/issue-tracking/collect.mjs, seed.mjs):
//
//   (a) volume: the paged list walks every issue; the list page, search, a filter and one issue open within budgets.
//   (b) import: every seeded record is an issue, with its title, and how long the seed took.
//   (c) links: each imported record's work links are posted by a machine (a runner's token); from an issue, one click
//       reaches who works on it, the session, the queue entry, the merge and the review; the list filters to issues
//       linked to a pull request or a queued merge.
//   (d) status: an issue's status follows the work as a machine posts it, with no person editing it, live on the page.
//   (e) VibeLang end to end: an issue on the repository's VibeLang project becomes a TODO, a runner's agent (the
//       deterministic ACP test agent) changes a .vibe file in a mirror it cloned with the host's read credential
//       (decision 0148), the App opens the pull request, a person merges it in Smithers, and "Fixes #n" closes the issue.
//
// One command: `E2E_PROD_URL=https://smithers.sh node e2e/prod.mjs e2e/issue-tracking.spec.ts --project=deployment`.
// It writes its numbers to test-results/issue-tracking.json and to each test's annotations; never a title or a body.
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type APIRequestContext, type Page } from "@playwright/test"
import { workStatusOf, type WorkLinkKind, type WorkLinkState } from "../src/features/issues/work"
import { expect, test } from "./fixtures"
import { cleanUp, type Runner, startRunner } from "./runner"
import { configureStack, dropTodo, serverState, stackChange } from "./stackWrites"
import { baseURL, requires } from "./target"

requires("trackingRepository")

const env = process.env
const repo = env.E2E_TRACKING_REPOSITORY ?? ""
const [owner = "", name = ""] = repo.split("/")
/** How many issues the volume and import phases need: the seed's progress decides the default. */
const minimum = Number(env.E2E_TRACKING_MIN_ISSUES ?? "500")
/** How many imported issues the links phase links and checks. */
const linked = Number(env.E2E_TRACKING_LINKED ?? "500")
const tokenFile = env.E2E_TRACKING_RUNNER_TOKEN_FILE ?? join(dirname(env.E2E_TRACKING_RECORDS ?? "."), "runner-token")
const RUNNER = "issue-tracking-proof"
const numbersFile = join("test-results", "issue-tracking.json")

interface Link { readonly kind: WorkLinkKind; readonly ref: string; readonly label?: string; readonly state?: WorkLinkState; readonly url?: string }
interface TrackedRecord { readonly key: string; readonly kind: string; readonly title: string; readonly links: ReadonlyArray<Link> }
interface Listed { readonly number: number; readonly title: string; readonly state: string; readonly work: { readonly status: string; readonly links: ReadonlyArray<{ kind: string; ref: string; url: string | null; state: string | null }> } }

const lines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
const records = (): ReadonlyArray<TrackedRecord> => lines(env.E2E_TRACKING_RECORDS!)
const sent = (): ReadonlyArray<{ key: string; writeId: string; at: string }> => lines(env.E2E_TRACKING_SEED_STATE!)

/** The numbers this run measured, merged into one file as each phase finishes. */
const record = (phase: string, numbers: Readonly<Record<string, unknown>>) => {
  mkdirSync("test-results", { recursive: true })
  const all = existsSync(numbersFile) ? JSON.parse(readFileSync(numbersFile, "utf8")) : {}
  writeFileSync(numbersFile, JSON.stringify({ ...all, [phase]: { ...numbers, at: new Date().toISOString() } }, null, 2))
  test.info().annotations.push({ type: phase, description: JSON.stringify(numbers) })
}

const timed = async <A>(run: () => Promise<A>): Promise<[A, number]> => {
  const started = performance.now()
  const value = await run()
  return [value, Math.round(performance.now() - started)]
}

const listRoute = `/api/repos/${owner}/${name}/issues`

/** Every issue of the repository, walking the paged route; and each page's time. */
const walk = async (request: APIRequestContext, query = "state=all&limit=100", headers: Readonly<Record<string, string>> = {}) => {
  const issues: Array<Listed> = []
  const pages: Array<number> = []
  let next: string | undefined = `${listRoute}?${query}`
  while (next !== undefined) {
    const [response, ms] = await timed(() => request.get(next!, { headers }))
    expect(response.status(), next).toBe(200)
    pages.push(ms)
    issues.push(...(await response.json()) as Array<Listed>)
    next = /<([^>]+)>;\s*rel="next"/.exec(response.headers()["link"] ?? "")?.[1]
  }
  return { issues, pages }
}

const percentile = (values: ReadonlyArray<number>, p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0

/** The runner's token: made once, mode 600, and registered on the repository in the test person's own session. */
const runnerToken = async (page: Page) => {
  if (!existsSync(tokenFile)) {
    mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 })
    writeFileSync(tokenFile, randomBytes(32).toString("base64url"), { mode: 0o600 })
  }
  const token = readFileSync(tokenFile, "utf8").trim()
  const tokenSha256 = createHash("sha256").update(token).digest("hex")
  await page.goto(`/${repo}/issues`)
  const status = await page.evaluate(async ({ path, tokenSha256 }) => {
    const { personId } = await (await fetch("/api/auth/session")).json()
    const response = await fetch(path, {
      method: "PUT",
      body: JSON.stringify({ tokenSha256, labels: ["issue-tracking-proof"], capacity: 1 }),
      headers: { "content-type": "application/json", "x-smithers-device-person": personId },
    })
    return response.status
  }, { path: `/api/repos/${owner}/${name}/runners/${RUNNER}`, tokenSha256 })
  // 202: `admin/SetRunner` started; the runner's token works once its row is written (a few seconds on production).
  expect(status).toBe(202)
  await expect.poll(async () => (await page.request.get(`${listRoute}?limit=1`, { headers: { authorization: `Bearer ${token}` } })).status(), {
    timeout: 60_000,
    intervals: [1_000, 2_000],
  }).toBe(200)
  return token
}

/** Posts `links` to issue `number` as the runner: the machine, not a person. */
const post = async (request: APIRequestContext, token: string, number: number, links: ReadonlyArray<Link & { at?: string }>) => {
  const response = await request.post(`/api/repos/${owner}/${name}/issues/${number}/links`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { links },
  })
  expect(response.status(), `links of #${number}`).toBe(200)
  return (await response.json()) as { links: number; changed: number }
}

/** Each seeded record's issue number, from the person's writes (the seed's write ids), and the seeded keys. */
const numbersByKey = async (page: Page) => {
  const writes = await page.evaluate(async () => {
    const rows = new Map<string, { id: string; item_number: string | null; status: string; repo_id: string }>()
    let url = "/api/shapes/github-writes?offset=-1"
    for (let i = 0; i < 500; i++) {
      const response = await fetch(url)
      const body = await response.json() as Array<{ key?: string; value?: Record<string, string>; headers?: { control?: string } }>
      for (const message of body) if (message.key !== undefined && message.value !== undefined) rows.set(message.key, { ...rows.get(message.key), ...message.value } as never)
      if (body.some((message) => message.headers?.control === "up-to-date")) break
      url = `/api/shapes/github-writes?offset=${response.headers.get("electric-offset")}&handle=${response.headers.get("electric-handle")}`
    }
    return [...rows.values()]
  })
  const byWrite = new Map(writes.filter((write) => write.repo_id === `github/${repo.toLowerCase()}` || write.repo_id === `github/${repo}`).map((write) => [write.id, write]))
  const numbers = new Map<string, number>()
  const notDone: Array<string> = []
  for (const { key, writeId } of sent()) {
    const write = byWrite.get(writeId)
    if (write?.status === "done" && write.item_number !== null) numbers.set(key, Number(write.item_number))
    else notDone.push(`${key}:${write?.status ?? "absent"}`)
  }
  return { numbers, notDone }
}

/** Opens an issue through the writes route as the test person, and answers its number once GitHub made it. */
const createIssue = async (page: Page, title: string) => {
  await page.goto(`/${repo}/issues`)
  const writeId = crypto.randomUUID()
  const status = await page.evaluate(async ({ path, writeId, title }) => {
    const { personId } = await (await fetch("/api/auth/session")).json()
    const response = await fetch(path, {
      method: "POST",
      body: JSON.stringify({ writeId, op: "issue/create", title, body: "Made by e2e/issue-tracking.spec.ts to watch its status follow the work." }),
      headers: { "content-type": "application/json", "x-smithers-device-person": personId },
    })
    return response.status
  }, { path: `/api/repos/${owner}/${name}/writes`, writeId, title })
  expect(status).toBe(202)
  let number: number | undefined
  await expect.poll(async () => {
    const { issues } = await walk(page.request, `state=open&limit=5`)
    number = issues.find((issue) => issue.title === title)?.number
    return number
  }, { timeout: 180_000, intervals: [2_000, 5_000] }).toBeDefined()
  return number!
}

test("(a) volume: the list pages, searches, filters and opens one issue at the seeded volume, within budgets", async ({ page, request }) => {
  test.setTimeout(15 * 60_000)
  const [{ issues, pages }, walkMs] = await timed(() => walk(request))
  test.skip(issues.length < minimum, `the repository has ${issues.length} issues; this run needs ${minimum} (E2E_TRACKING_MIN_ISSUES): the seed is still running`)
  expect(new Set(issues.map((issue) => issue.number)).size).toBe(issues.length)
  const [first, firstPageMs] = await timed(() => request.get(`${listRoute}?limit=30`))
  expect(first.status()).toBe(200)
  const probe = issues[Math.floor(issues.length / 2)]!
  const word = probe.title.split(/\s+/).find((part) => part.length >= 6) ?? probe.title.slice(0, 8)
  const [search, searchMs] = await timed(() => request.get(`${listRoute}?state=all&q=${encodeURIComponent(word)}&limit=100`))
  expect(((await search.json()) as Array<Listed>).length).toBeGreaterThan(0)
  const [byNumber, numberMs] = await timed(() => request.get(`${listRoute}?state=all&q=%23${probe.number}`))
  expect(((await byNumber.json()) as Array<Listed>).map((issue) => issue.number)).toEqual([probe.number])
  const [closed, closedMs] = await timed(() => request.get(`${listRoute}?state=closed&limit=100`))
  expect(closed.status()).toBe(200)

  // The browser: the list page's first rows, its search, and one issue's page.
  const [, listPageMs] = await timed(async () => {
    await page.goto(`/${repo}/issues`)
    await expect(page.locator(`a[href$="/${repo}/issues/${issues[0]!.number}"]`).first()).toBeVisible({ timeout: 120_000 })
  })
  const [, listSearchMs] = await timed(async () => {
    await page.getByRole("searchbox", { name: "Search issues" }).or(page.getByRole("textbox", { name: "Search issues" })).fill(`#${probe.number}`)
    await expect(page.locator(`a[href$="/${repo}/issues/${probe.number}"]`).first()).toBeVisible({ timeout: 60_000 })
  })
  const [, openMs] = await timed(async () => {
    await page.goto(`/${repo}/issues/${probe.number}`)
    await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: `#${probe.number}` })).toContainText(probe.title.slice(0, 40), { timeout: 60_000 })
  })
  const numbers = {
    issues: issues.length,
    pages: pages.length,
    walkMs,
    pageP50Ms: percentile(pages, 0.5),
    pageP95Ms: percentile(pages, 0.95),
    firstPageMs,
    searchMs,
    searchByNumberMs: numberMs,
    closedFilterMs: closedMs,
    browserListFirstRowsMs: listPageMs,
    browserListSearchMs: listSearchMs,
    browserOpenIssueMs: openMs,
  }
  record("volume", numbers)
  // Usable: a page of the API in under 2 s at p95, the browser's list in under 30 s cold, an issue in under 10 s.
  expect(numbers.pageP95Ms).toBeLessThan(2_000)
  expect(numbers.searchMs).toBeLessThan(3_000)
  expect(numbers.browserListFirstRowsMs).toBeLessThan(30_000)
  expect(numbers.browserListSearchMs).toBeLessThan(5_000)
  expect(numbers.browserOpenIssueMs).toBeLessThan(10_000)
})

test("(b) import: every seeded record is an issue with its title, and the seed's time is known", async ({ page, request }) => {
  test.setTimeout(15 * 60_000)
  const seeded = sent()
  test.skip(seeded.length < minimum, `the seed sent ${seeded.length} records; this run needs ${minimum}`)
  await page.goto(`/${repo}/issues`)
  const { numbers, notDone } = await numbersByKey(page)
  const { issues } = await walk(request)
  const titleOf = new Map(issues.map((issue) => [issue.number, issue.title]))
  const byKey = new Map(records().map((row) => [row.key, row]))
  const missing = [...numbers].filter(([key, number]) => titleOf.get(number) !== byKey.get(key)?.title).map(([key]) => key)
  const times = seeded.map((row) => Date.parse(row.at)).sort((a, b) => a - b)
  const kinds = [...numbers.keys()].reduce<Record<string, number>>((acc, key) => ({ ...acc, [key.split(":")[0]!]: (acc[key.split(":")[0]!] ?? 0) + 1 }), {})
  record("import", {
    seeded: seeded.length,
    issues: numbers.size,
    byKind: kinds,
    pendingOrFailed: notDone.length,
    titleMismatches: missing.length,
    firstSentAt: new Date(times[0]!).toISOString(),
    lastSentAt: new Date(times.at(-1)!).toISOString(),
    seedHours: Math.round(((times.at(-1)! - times[0]!) / 3_600_000) * 100) / 100,
  })
  // Writes still in flight are the newest few; every older one became its issue with its title.
  expect(notDone.length).toBeLessThan(20)
  expect(missing).toEqual([])
})

test("(c) links: a machine links each imported record to its work; one click reaches each; the list filters to PRs and queued merges", async ({ page, request }) => {
  test.setTimeout(30 * 60_000)
  const token = await runnerToken(page)
  const { numbers } = await numbersByKey(page)
  const issueUrl = (key: string) => (numbers.has(key) ? `${new URL(baseURL).origin}/${repo}/issues/${numbers.get(key)}` : undefined)
  // A link reaches the issue that holds what it names: the lane's, the queue entry's, the review's; a merge, GitHub's commit.
  const addressed = (link: Link): Link => {
    const url = link.kind === "assignee" || link.kind === "session"
      ? issueUrl(`lane:${link.ref.replace(/^lane:/, "")}`)
      : link.kind === "queue" ? issueUrl(`queue:${link.ref}`)
      : link.kind === "review" ? issueUrl(link.ref)
      : link.kind === "merge" ? `https://github.com/smithersai/vibelang/commit/${link.ref}`
      : link.url
    return url === undefined ? link : { ...link, url }
  }
  const chosen = records().filter((row) => row.links.length > 0 && numbers.has(row.key)).slice(0, linked)
  test.skip(chosen.length === 0, "no imported record with work links yet: the seed is still running")
  const [, postMs] = await timed(async () => {
    for (const row of chosen) await post(request, token, numbers.get(row.key)!, row.links.slice(0, 50).map(addressed))
  })
  // The list's work for each matches the status the links imply, read with the machine's own token.
  const { issues } = await walk(request, "state=all&limit=100&work=any", { authorization: `Bearer ${token}` })
  const work = new Map(issues.map((issue) => [issue.number, issue.work]))
  const wrong = chosen.filter((row) => {
    const found = work.get(numbers.get(row.key)!)
    return found === undefined || found.links.length < new Set(row.links.slice(0, 50).map((link) => `${link.kind}/${link.ref}`)).size
  })
  expect(wrong.map((row) => row.key)).toEqual([])
  const { issues: prOrQueue } = await walk(request, "state=all&limit=100&work=pr-or-queue")
  const expected = chosen.filter((row) => row.links.some((link) => link.kind === "queue" || link.kind === "pr")).map((row) => numbers.get(row.key)!)
  expect(new Set(prOrQueue.map((issue) => issue.number))).toEqual(new Set(issues.filter((issue) => issue.work.links.some((link) => link.kind === "queue" || link.kind === "pr")).map((issue) => issue.number)))
  expect(expected.every((number) => prOrQueue.some((issue) => issue.number === number))).toBe(true)

  // The browser: a lane with a queue entry and a merge. Each link is one click to the issue or commit it names.
  // The record whose links reach the most of who, session, queue entry and merge: a lane with a landed queue entry, or
  // a queue entry, whose session link reaches its lane's issue.
  const reach = (row: TrackedRecord) =>
    new Set(row.links.map(addressed).filter((link) => link.url !== undefined && ["assignee", "session", "queue", "merge"].includes(link.kind)).map((link) => link.kind)).size
  const lane = [...chosen].sort((a, b) => reach(b) - reach(a))[0]!
  const laneNumber = numbers.get(lane.key)!
  await page.goto(`/${repo}/issues/${laneNumber}`)
  const clicks: Array<{ kind: string; ms: number }> = []
  for (const kind of ["assignee", "session", "queue", "merge"] as const) {
    const link = lane.links.map(addressed).find((candidate) => candidate.kind === kind && candidate.url !== undefined)
    if (link === undefined) continue
    const section = page.getByRole("region", { name: { assignee: "Working on it", session: "Session", queue: "Queue entry", merge: "Merge" }[kind] })
    // A link to this app shows as its path and opens in place (a deployment before that showed the whole URL, which
    // opens a new tab); GitHub's opens in a new tab. Either way: one click, and the page it reaches is the one named.
    const path = link.url!.startsWith(new URL(baseURL).origin) ? link.url!.slice(new URL(baseURL).origin.length) : link.url!
    const anchor = section.locator(`a[href="${path}"], a[href="${link.url}"]`).first()
    await expect(anchor, kind).toBeVisible({ timeout: 60_000 })
    const [, ms] = await timed(async () => {
      const opensTab = (await anchor.getAttribute("target")) === "_blank"
      if (opensTab) {
        const [opened] = await Promise.all([page.context().waitForEvent("page"), anchor.click()])
        await opened.waitForLoadState("domcontentloaded")
        expect(opened.url()).toContain(kind === "merge" ? link.ref : path)
        if (kind !== "merge") await expect(opened.getByRole("heading", { level: 1 }).filter({ hasText: /#\d+/ })).toBeVisible({ timeout: 30_000 })
        await opened.close()
      } else {
        await anchor.click()
        await expect(page).toHaveURL(link.url!, { timeout: 30_000 })
        await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: /#\d+/ })).toBeVisible({ timeout: 30_000 })
      }
    })
    clicks.push({ kind, ms })
    await page.goto(`/${repo}/issues/${laneNumber}`)
  }
  expect(clicks.map((click) => click.kind)).toEqual(expect.arrayContaining(["session", "queue"]))
  // Will's list: issues linked to a pull request or a queued merge, on the page.
  await page.goto(`/${repo}/issues?work=pr-or-queue`)
  await expect(page.locator(`a[href$="/${repo}/issues/${laneNumber}"]`).first()).toBeVisible({ timeout: 120_000 })
  record("links", { linkedIssues: chosen.length, postMs, prOrQueueIssues: prOrQueue.length, clicks, laneIssue: laneNumber })
})

test("(d) status: an issue's status follows the work a machine posts, live on its page, with no person editing it", async ({ page, request }) => {
  test.setTimeout(10 * 60_000)
  const token = await runnerToken(page)
  // A new issue each run, so its status starts at none: one GitHub write, in the test person's session.
  const target = await createIssue(page, `Status proof ${new Date().toISOString()}`)
  await page.goto(`/${repo}/issues/${target}`)
  await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: `#${target}` })).toBeVisible({ timeout: 60_000 })
  const ref = `proof-${Date.now()}`
  const base = Date.now()
  const at = (minutes: number) => new Date(base - 60 * 60_000 + minutes * 60_000).toISOString()
  const steps: ReadonlyArray<readonly [ReadonlyArray<Link & { at: string }>, string]> = [
    [[{ kind: "assignee", ref: "issue-tracking-proof", at: at(0) }, { kind: "session", ref: `lane:${ref}`, state: "working", at: at(1) }], "Working"],
    [[{ kind: "queue", ref, state: "queued", at: at(2) }], "Queued to merge"],
    [[{ kind: "queue", ref, state: "failed", at: at(3) }], "Failed"],
    [[{ kind: "session", ref: `lane:${ref}`, state: "working", at: at(4) }], "Working"],
    [[{ kind: "queue", ref, state: "passed", at: at(5) }], "Passed the queue"],
    [[{ kind: "merge", ref, state: "merged", at: at(6) }], "Merged"],
  ]
  const seen: Array<{ status: string; ms: number }> = []
  for (const [links, label] of steps) {
    const [, ms] = await timed(async () => {
      await post(request, token, target, links)
      // No reload: the page's synced links move the status.
      await expect(page.getByRole("region", { name: "Work", exact: true })).toContainText(label, { timeout: 60_000 })
    })
    seen.push({ status: label, ms })
  }
  const listed = ((await (await request.get(`${listRoute}?state=all&q=%23${target}`)).json()) as Array<Listed>)[0]!
  expect(listed.work.status).toBe("merged")
  expect(workStatusOf(listed.work.links.map((link) => ({ kind: link.kind as WorkLinkKind, state: link.state as WorkLinkState | null, updatedAt: "" })))).toBe("merged")
  // Nobody pressed anything: every link's source is the machine.
  expect(new Set((listed.work.links as ReadonlyArray<{ source?: string }>).map((link) => link.source))).toEqual(new Set([`runner:${RUNNER}`]))
  record("status", { issue: target, steps: seen })
})

test("(e) VibeLang end to end: an issue becomes a TODO, an agent's pull request, CI, and a merge that closes it", async ({ page }) => {
  test.setTimeout(40 * 60_000)
  // Before anything is written: a deployment without the runner's read credential can't fetch a private repository.
  const probe = await page.request.post("/api/runners/git-credential", { data: {} })
  expect(probe.status(), "the deployment serves POST /api/runners/git-credential (decision 0148)").not.toBe(404)
  const word = `v${Date.now().toString(36)}`
  const started = Date.now()
  const issue = await createIssue(page, `greeting: export a proof constant ${word}`)
  // The runner starts with no mirror: it clones the private repository with the host's read credential (decision 0148).
  const mirror = join(mkdtempSync(join(tmpdir(), "issue-tracking-mirror-")), "mirror")
  let runner: Runner | undefined
  let todo: number | undefined
  let merged = false
  try {
    runner = await startRunner(page, repo, word, 1, { mirror })
    expect(await configureStack(page, repo, 1, "independent")).toMatchObject({ status: 202 })
    // The deterministic ACP test agent's script stands in for a model's change (e2e/runner.ts): one VibeLang line.
    const committed = await stackChange(page, repo, {
      op: "commit",
      title: `Export a proof constant ${word}`,
      prompt: `add the line \`export const proof = "${word}"\` to \`src/proof.vibe\``,
      issue,
    })
    expect(committed).toMatchObject({ status: 202, body: { outcome: "committed" } })
    todo = committed.body.number!
    await expect.poll(() => serverState(page, repo, todo!), { timeout: 20 * 60_000, intervals: [5_000] }).toBe("in_review")
    const inReviewMs = Date.now() - started
    expect(existsSync(join(mirror, ".jj")), "the runner cloned the private mirror").toBe(true)
    const pr = ((await (await page.request.get(`/api/repos/${repo}/stack/${todo}`)).json()) as { prNumber: number }).prNumber
    expect(pr).toBeGreaterThan(0)
    // A person merges it in Smithers, in person.
    await page.goto(`/${repo}/pull/${pr}`)
    await page.getByRole("button", { name: "Squash and merge" }).click({ timeout: 120_000 })
    await expect.poll(() => serverState(page, repo, todo!), { timeout: 10 * 60_000, intervals: [5_000] }).toBe("merged")
    merged = true
    // "Fixes #n" closes the issue on GitHub, and the projection follows.
    await expect.poll(async () => {
      const listed = ((await (await page.request.get(`${listRoute}?state=all&q=%23${issue}`)).json()) as Array<Listed>)[0]
      return listed?.state
    }, { timeout: 10 * 60_000, intervals: [5_000] }).toBe("closed")
    record("vibelang", { issue, todo, pr, inReviewMs, closedMs: Date.now() - started })
  } finally {
    await runner?.attach().catch(() => undefined)
    await cleanUp(
      () => (todo === undefined || merged ? Promise.resolve() : dropTodo(page, repo, todo)),
      () => configureStack(page, repo, 1, "stacked"),
      () => runner?.stop() ?? Promise.resolve(),
      async () => rmSync(dirname(mirror), { recursive: true, force: true }),
    )
  }
})
