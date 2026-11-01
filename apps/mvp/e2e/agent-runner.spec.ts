import type { Page } from "@playwright/test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createServer, type IncomingMessage, request as httpRequest, type Server } from "node:http"
import { request as httpsRequest } from "node:https"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { expect, test } from "./devices"
import { step } from "./fixtures"
import { github } from "./github"
import { cleanUp, type Runner, startRunner } from "./runner"
import { configureStack, dropTodo } from "./stackWrites"
import { baseURL, onThisMachine, requires } from "./target"
import { expectServerError } from "./watch"

// A TODO coded by an external agent on a runner (decision 0136, docs/features/agent-runners.md): an Admin registers a
// runner and names the repository's coding agent, the spec starts that runner itself (`smthrs runner serve`) with the
// deterministic ACP test agent as the profile's command, a person commits a TODO, and the App opens its pull request
// with the agent's change. Everything is real: the app, its routes and flows, Postgres, the runner, its jj checkout, the
// agent process and GitHub. The test agent stands in for a model, so this proves the seam; a real agent's lane is the
// production proof (FINAL.md §5).
//
// A person watches the agent's run live (decision 0141, docs/features/agent-transcripts.md): the TODO's run page shows
// the Transcript panel's first message within 30 s of the commit; the spec's runner reaches the app through a loopback
// proxy of the spec's own, which refuses the runner's transcript posts for a minute, after which the transcript catches
// up with every event once and in order; events after that reach the page within 3 s at the 95th percentile; and a
// second browser, opening the run afresh, replays the same events with the run's own digest.
//
// "steers" and "stops" (decision 0142): a person steers the agent from the run's page and the steer's line is in the
// pull request; a person stops an agent parked in a 10-minute command, the runner ends its whole process tree, and
// nothing reaches GitHub. The run's Transcript panel shows each steer and the stop where they reached the agent.
//
// It writes to GitHub, so it runs only signed in through the GitHub App, against a deployment or a dev build, on a
// scratch repository the test account administers (`agentRunner`, e2e/target.ts). It never merges. The runner's setup
// is e2e/runner.ts.

const repo = process.env.E2E_FACTORY_REPOSITORY ?? ""

// A TODO's row says Working a moment before its run can be read: Watch's first read may be 404, and the page reads
// again (http.request.recovered). Only the TODO's own run: a run it started must always be readable.
expectServerError(404, "/api/remote-runs/todo*")

/**
 * The app's origin on a loopback port, for the spec's runner: every request passes through, except the runner's
 * transcript posts while `blocked` says so, which are answered 503 as an app that can't take them would be.
 */
const relay = async () => {
  const target = new URL(baseURL)
  const state = { blockedUntil: 0, refused: 0 }
  const server: Server = createServer((incoming: IncomingMessage, outgoing) => {
    if (incoming.url === "/api/runners/events" && Date.now() < state.blockedUntil) {
      state.refused++
      incoming.resume()
      outgoing.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ code: "unavailable" }))
      return
    }
    const forward = (target.protocol === "https:" ? httpsRequest : httpRequest)({
      host: target.hostname,
      port: target.port === "" ? undefined : Number(target.port),
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: target.host },
      rejectUnauthorized: !onThisMachine(baseURL),
    }, (answer) => {
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(outgoing)
    })
    forward.on("error", () => outgoing.writeHead(502).end())
    incoming.pipe(forward)
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, state }
}

/** One transcript event as the page's socket received it, and when. */
interface Received {
  readonly n: number
  readonly generation: number
  readonly seq: number
  readonly at: number
  readonly kind: string
  readonly receivedAt: number
}

/** Every transcript event `page`'s sockets receive, with when it arrived, and when each replay went live. */
const transcriptFrames = (page: Page) => {
  const events: Array<Received> = []
  const live: Array<number> = []
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/transcript")) return
    socket.on("framereceived", ({ payload }) => {
      const receivedAt = Date.now()
      const frame = JSON.parse(String(payload)) as { type: string; events?: ReadonlyArray<Omit<Received, "receivedAt">> }
      if (frame.type === "live") live.push(receivedAt)
      for (const event of frame.events ?? []) events.push({ ...event, receivedAt })
    })
  })
  return { events, live }
}

const percentile = (values: ReadonlyArray<number>, p: number) => [...values].sort((a, b) => a - b)[Math.floor(values.length * p)]!

test("agent runner: an external agent's TODO publishes a pull request, watched live", {
  annotation: { type: "summary", description: "An Admin points TODOs at an agent on a runner; a person watches it live; the App opens its pull request." },
}, async ({ devices, browser }) => {
  requires("agentRunner")
  test.setTimeout(15 * 60_000)
  // A device of its own (e2e/devices.ts): Commit needs the browser's engine, which a private window can't run.
  const [maya] = await devices.open("Maya")
  const page = maya!.page
  const frames = transcriptFrames(page)
  const proxy = await relay()
  const word = `a${Date.now().toString(36)}`
  const row = page.getByRole("region", { name: `${repo} stack` }).locator("[data-slot=issues-row]", { hasText: word })
  let runner: Runner | undefined
  let number: string | undefined
  try {
    await step("An Admin registers a runner and names the coding agent", async () => {
      await page.goto(`/${repo}/stack`)
      // Through the spec's relay, so the spec can refuse the runner's transcript posts for a minute.
      runner = await startRunner(page, repo, word, 1, { origin: proxy.origin })
      // Independent lanes: the TODO starts whatever else the shared scratch stack holds open (decision 0135).
      expect(await configureStack(page, repo, 1, "independent")).toMatchObject({ status: 202 })
    })

    const title = `Note alpha ${word}`
    let committedAt = 0
    await step("A person commits a TODO", async () => {
      await page.getByRole("button", { name: "New TODO", exact: true }).click()
      const draft = page.getByRole("form", { name: "TODO draft" })
      await draft.getByLabel("Title", { exact: true }).fill(title)
      // The test agent talks for two minutes, a chunk every 250 ms, then makes its change.
      await draft.getByLabel("Prompt", { exact: true }).fill(`talk for 120 seconds\nadd the line \`alpha ${word}\` to \`NOTES.md\``)
      await draft.getByRole("button", { name: "Commit", exact: true }).click()
      committedAt = Date.now()
    })

    await step("The runner's agent works on it", async () => {
      await expect(row).toHaveAttribute("data-status", /running|in_review/, { timeout: 60_000 })
      // The row is the stack page's: the cleanup needs its number on any other page.
      await expect(row).toContainText(/T\d+/, { timeout: 60_000 })
      number = (await row.textContent())!.match(/T(\d+)/)![1]!
    })

    const panel = page.getByRole("region", { name: "Transcript", exact: true })
    await step("A person watches the agent: its first message within 30 s of the commit", async () => {
      await row.getByRole("link", { name: "Watch", exact: true }).click()
      await expect(panel.getByText("Working through", { exact: false })).toBeVisible({
        timeout: Math.max(1, committedAt + 30_000 - Date.now()),
      })
      test.info().annotations.push({ type: "first message", description: `${Date.now() - committedAt} ms after the commit` })
    })

    const blockedAt = Date.now()
    await step("The app refuses the runner's transcript for a minute; the panel holds what it has", async () => {
      proxy.state.blockedUntil = blockedAt + 60_000
      await page.waitForTimeout(60_000)
      expect(proxy.state.refused, "the runner tried to post during the minute").toBeGreaterThan(0)
    })

    await step("The transcript catches up with every event once and in order, then follows live", async () => {
      const unblocked = blockedAt + 60_000
      await expect.poll(() => frames.events.filter((event) => event.at > unblocked + 15_000).length, { timeout: 60_000 })
        .toBeGreaterThan(20)
      const ns = frames.events.map((event) => event.n)
      expect(ns, "every event once, in order, with no gap").toEqual(ns.map((_, index) => index + 1))
      const seqs = frames.events.map((event) => event.seq)
      expect(seqs, "the runner's numbering has no gap either").toEqual(seqs.map((_, index) => index))
      // Lag from the runner to this page, once the backlog is in: events after the minute and 15 s more.
      const lags = frames.events.filter((event) => event.at > unblocked + 15_000).map((event) => event.receivedAt - event.at)
      const p95 = percentile(lags, 0.95)
      test.info().annotations.push({ type: "lag", description: `p50 ${percentile(lags, 0.5)} ms, p95 ${p95} ms over ${lags.length} events` })
      expect(p95, "event to viewer, p95").toBeLessThanOrEqual(3000)
      await expect(panel).toHaveAttribute("data-phase", "live")
    })

    await step("The agent finishes, and the transcript says so", async () => {
      await expect(panel.getByText("The agent finished.")).toBeVisible({ timeout: 10 * 60_000 })
    })

    await step("Another browser opens the run afresh and replays the same transcript, with the run's digest", async () => {
      const count = await panel.getAttribute("data-events")
      const second = await browser.newContext({ storageState: await page.context().storageState(), ignoreHTTPSErrors: true })
      try {
        const other = await second.newPage()
        await other.goto(page.url())
        const replayed = other.getByRole("region", { name: "Transcript", exact: true })
        await expect(replayed).toHaveAttribute("data-verified", "true", { timeout: 60_000 })
        await expect(replayed).toHaveAttribute("data-events", count!)
        await expect(replayed.getByText("The agent finished.")).toBeVisible()
      } finally {
        await second.close()
      }
      await page.reload()
      await expect(panel).toHaveAttribute("data-verified", "true", { timeout: 60_000 })
      await expect(panel).toHaveAttribute("data-events", count!)
    })

    await step("The App opens its pull request with the agent's change", async () => {
      await page.goto(`/${repo}/stack`)
      // Settled either way, then In review: a failed TODO fails the test at once, with the runner's log.
      await expect(row).toHaveAttribute("data-status", /in_review|failed/, { timeout: 10 * 60_000 })
      await expect(row).toHaveAttribute("data-status", "in_review")
      const pulls = await github<Array<{ number: number; head: { ref: string }; user: { type: string } }>>(
        page,
        `/repos/${repo}/pulls?state=open&per_page=100`,
      )
      const pull = pulls.find((each) => each.head.ref.startsWith(`smithers/t${number}-`))
      expect(pull, "one pull request on the TODO's branch").toBeDefined()
      expect(pull!.user.type).toBe("Bot")
      const files = await github<Array<{ filename: string; patch?: string }>>(page, `/repos/${repo}/pulls/${pull!.number}/files`)
      expect(files.map((file) => file.filename)).toEqual(["NOTES.md"])
      expect(files[0]!.patch).toContain(`+alpha ${word}`)
    })
  } catch (error) {
    await runner?.attach()
    throw error
  } finally {
    const api = { request: runner?.api ?? page.request }
    await cleanUp(
      async () => { if (number !== undefined) await dropTodo(api, repo, Number(number)) },
      () => configureStack(api, repo, 1, "stacked"),
      async () => { await runner?.stop() },
    )
    proxy.server.close()
  }
})

/** Commits a TODO with `prompt` from the stack page; answers its row. */
const commitTodo = async (page: Page, title: string, prompt: string) => {
  await step("A person commits a TODO", async () => {
    await page.getByRole("button", { name: "New TODO", exact: true }).click()
    const draft = page.getByRole("form", { name: "TODO draft" })
    await draft.getByLabel("Title", { exact: true }).fill(title)
    await draft.getByLabel("Prompt", { exact: true }).fill(prompt)
    await draft.getByRole("button", { name: "Commit", exact: true }).click()
  })
  return page.getByRole("region", { name: `${repo} stack` }).locator("[data-slot=issues-row]", { hasText: title })
}

/** The App's open pull request on TODO `number`'s branch, and the files it changes. */
const pullOf = async (page: Page, number: string) => {
  const pulls = await github<Array<{ number: number; head: { ref: string }; user: { type: string } }>>(
    page,
    `/repos/${repo}/pulls?state=open&per_page=100`,
  )
  const pull = pulls.find((each) => each.head.ref.startsWith(`smithers/t${number}-`))
  expect(pull, "one pull request on the TODO's branch").toBeDefined()
  expect(pull!.user.type).toBe("Bot")
  const files = await github<Array<{ filename: string; patch?: string }>>(page, `/repos/${repo}/pulls/${pull!.number}/files`)
  return { pull: pull!, files }
}

const numberOf = async (row: ReturnType<Page["locator"]>) => (await row.textContent())!.match(/T(\d+)/)![1]!

/**
 * One test's runner on Maya's own device, with the stack's lanes independent while it runs; `body` answers the TODO
 * it committed, which is dropped after, and the stack, the runner and its agent are put back whatever happens.
 */
const withRunner = async (
  devices: { readonly open: (...names: Array<string>) => Promise<ReadonlyArray<{ readonly page: Page }>> },
  body: (context: {
    readonly page: Page
    readonly runner: Runner
    readonly word: string
    /** The TODO's number, once its row shows it, for the cleanup: the row is gone from any other page. */
    readonly committed: (row: ReturnType<Page["locator"]>) => Promise<string>
  }) => Promise<void>,
) => {
  const [maya] = await devices.open("Maya")
  const page = maya!.page
  const word = `a${Date.now().toString(36)}`
  let runner: Runner | undefined
  let number: string | undefined
  const committed = async (row: ReturnType<Page["locator"]>) => {
    await expect(row).toContainText(/T\d+/, { timeout: 60_000 })
    number = await numberOf(row)
    return number
  }
  try {
    await step("An Admin registers a runner and names the coding agent", async () => {
      await page.goto(`/${repo}/stack`)
      runner = await startRunner(page, repo, word, 1)
      expect(await configureStack(page, repo, 1, "independent")).toMatchObject({ status: 202 })
    })
    await body({ page, runner: runner!, word, committed })
  } catch (error) {
    await runner?.attach()
    throw error
  } finally {
    const api = { request: runner?.api ?? page.request }
    await cleanUp(
      async () => { if (number !== undefined) await dropTodo(api, repo, Number(number)) },
      () => configureStack(api, repo, 1, "stacked"),
      async () => { await runner?.stop() },
    )
  }
}

test("agent runner steers: a person's message reaches the agent on its runner and its change is in the pull request", {
  annotation: { type: "summary", description: "Steer an external agent from its run page; it reads Delivered and the PR has its line." },
}, async ({ devices }) => {
  requires("agentRunner")
  test.setTimeout(15 * 60_000)
  await withRunner(devices, async ({ page, word, committed }) => {
    const row = await commitTodo(page, `Steered ${word}`, `run \`sleep 20\`\nadd the line \`alpha ${word}\` to \`NOTES.md\``)
    const number = await committed(row)
    const steer = `add the line \`steer ${word}\` to \`NOTES.md\``
    const messages = page.getByRole("region", { name: "Steer" }).getByRole("listitem").filter({ hasText: `steer ${word}` })
    await step("Watch opens its run on Cloudflare while the agent works", async () => {
      await expect(row).toHaveAttribute("data-status", "running", { timeout: 60_000 })
      await row.getByRole("link", { name: "Watch" }).click()
      await expect(page).toHaveURL(/\/app\/runs\/todo(%3A|:)/, { timeout: 30_000 })
    })
    await step("Steer the agent: Sent at once, then Delivered", async () => {
      const composer = page.getByRole("textbox", { name: "Steer the agent" })
      await expect(composer).toBeVisible({ timeout: 60_000 })
      const sentAt = Date.now()
      await composer.fill(steer)
      await composer.press("Enter")
      await expect(messages).toHaveAttribute("data-state", /sent|delivered/, { timeout: 5_000 })
      await expect(messages).toHaveAttribute("data-state", "delivered", { timeout: 60_000 })
      expect(Date.now() - sentAt).toBeLessThan(60_000)
    })
    await step("The run's transcript shows the steer where it reached the agent", async () => {
      const panel = page.getByRole("region", { name: "Transcript", exact: true })
      await expect(panel.getByText("A person steered the agent.")).toBeVisible({ timeout: 30_000 })
    })
    await step("Its pull request has the task's line and the steer's", async () => {
      await page.goto(`/${repo}/stack`)
      await expect(row).toHaveAttribute("data-status", /in_review|failed/, { timeout: 10 * 60_000 })
      await expect(row).toHaveAttribute("data-status", "in_review")
      const { files } = await pullOf(page, number)
      expect(files.map((file) => file.filename)).toEqual(["NOTES.md"])
      expect(files[0]!.patch).toContain(`+alpha ${word}`)
      expect(files[0]!.patch).toContain(`+steer ${word}`)
    })
  })
})

test("agent runner stops: Stop ends a parked agent's whole process tree and nothing reaches GitHub", {
  annotation: { type: "summary", description: "Stop an external agent parked in a long command: Stopping, then Stopped, no branch." },
}, async ({ devices }) => {
  requires("agentRunner")
  test.setTimeout(15 * 60_000)
  await withRunner(devices, async ({ page, runner, word, committed }) => {
    const row = await commitTodo(page, `Long sleep ${word}`, "run `sleep 600` detached")
    const number = await committed(row)
    const sleepers = () => {
      const directory = join(runner.state, "agent")
      return existsSync(directory)
        ? readdirSync(directory).filter((name) => name.startsWith("detached-")).map((name) =>
          Number(readFileSync(join(directory, name), "utf8"))
        )
        : []
    }
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await step("Its agent runs a 10-minute command on the runner", async () => {
      await expect(row).toHaveAttribute("data-status", "running", { timeout: 60_000 })
      await expect.poll(() => sleepers().length, { timeout: 60_000 }).toBe(1)
    })
    const [sleeper] = sleepers()
    // The run's header says where it stands, its glyph beside the word: the first of the page's status pills.
    const pill = page.locator("[data-slot=run-status]").first()
    await step("Watch opens its run while the agent works", async () => {
      await row.getByRole("link", { name: "Watch" }).click()
      await expect(page).toHaveURL(/\/app\/runs\/todo(%3A|:)/, { timeout: 30_000 })
    })
    await step("Stop: the run reads Stopping, and the command's process is gone within 20 s", async () => {
      // Parked between its step's probes: the step is waiting on its job, which no process here holds.
      await page.waitForTimeout(30_000)
      const asked = Date.now()
      await page.getByRole("button", { name: "Stop", exact: true }).click()
      await expect(pill).toHaveAttribute("data-word", "Stopping", { timeout: 10_000 })
      await expect.poll(() => alive(sleeper!), { timeout: 20_000 }).toBe(false)
      expect(Date.now() - asked).toBeLessThan(20_000)
    })
    await step("The run reads Stopped, the TODO Stopped, and it offers Retry", async () => {
      await expect(pill).toHaveAttribute("data-word", "Stopped", { timeout: 90_000 })
      const panel = page.getByRole("region", { name: "Transcript", exact: true })
      await expect(panel.getByText("Smithers stopped the agent.")).toBeVisible()
      await expect(panel.getByText("The agent was stopped.")).toBeVisible({ timeout: 60_000 })
      await page.goto(`/${repo}/stack/${number}`)
      const todo = page.getByRole("article", { name: new RegExp(`Long sleep ${word}`) })
      await expect(todo).toHaveAttribute("data-status", "failed", { timeout: 60_000 })
      await expect(todo).toContainText("Stopped")
      await expect(todo.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
    })
    await step("Nothing reached GitHub: no branch for the TODO", async () => {
      const branches = await github<Array<{ name: string }>>(page, `/repos/${repo}/branches?per_page=100`)
      expect(branches.map((branch) => branch.name).filter((name) => name.startsWith(`smithers/t${number}-`))).toEqual([])
    })
  })
})
