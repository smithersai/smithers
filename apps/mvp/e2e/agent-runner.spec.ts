import { expect, type Page, type TestInfo } from "@playwright/test"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, request as httpRequest, type Server } from "node:http"
import { request as httpsRequest } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { recordActions, step, themeOf, writeManifest } from "./fixtures"
import { github } from "./github"
import { baseURL, onThisMachine, requires } from "./target"
import { strictTest as test } from "./watch"

// A TODO coded by an external agent on a runner (decision 0133, docs/features/agent-runners.md): an Admin registers a
// runner and names the repository's coding agent, the spec starts that runner itself (`smthrs runner serve`) with the
// deterministic ACP test agent as the profile's command, a person commits a TODO, and the App opens its pull request
// with the agent's change. Everything is real: the app, its routes and flows, Postgres, the runner, its jj checkout, the
// agent process and GitHub. The test agent stands in for a model, so this proves the seam; a real agent's lane is the
// production proof (FINAL.md §5).
//
// A person watches the agent's run live (decision 0134, docs/features/agent-transcripts.md): the TODO's run page shows
// the Transcript panel's first message within 30 s of the commit; the spec's runner reaches the app through a loopback
// proxy of the spec's own, which refuses the runner's transcript posts for a minute, after which the transcript catches
// up with every event once and in order; events after that reach the page within 3 s at the 95th percentile; and a
// second browser, opening the run afresh, replays the same events with the run's own digest.
//
// It writes to GitHub, so it runs only on a dev build signing in through the GitHub App, against a scratch repository
// the test account administers (`agentRunner`, e2e/target.ts). It never merges.

const started = new WeakMap<TestInfo, number>()
const repo = process.env.E2E_FACTORY_REPOSITORY ?? ""
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const smthrs = join(root, "packages/smithers/bin/smithers.mjs")
const testAgent = join(root, "packages/smithers/agent/test/fixtures/acp-test-agent.mjs")

test.beforeEach(async ({ page }, info) => {
  started.set(info, Date.now())
  requires("agentRunner")
  await page.emulateMedia({ colorScheme: themeOf(info) })
  await recordActions(page, info, "Maya")
})

test.afterEach(async ({}, info) => {
  await writeManifest(info, "flow.json", started.get(info) ?? Date.now(), [{ name: "Maya", video: "video.webm", openedAt: 0 }])
})

/** An Admin's write to the repository's runners or agents, as the signed-in page. */
const adminWrite = async (page: Page, path: string, method: "PUT" | "DELETE", body?: unknown) => {
  const response = await page.request.fetch(new URL(`/api/repos/${repo}/${path}`, baseURL).href, {
    method,
    ...(body === undefined ? {} : { data: body }),
  })
  expect(response.status(), `${method} ${path}`).toBe(202)
}

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
}, async ({ page, browser }) => {
  test.setTimeout(15 * 60_000)
  const word = `a${Date.now().toString(36)}`
  const state = mkdtempSync(join(tmpdir(), "agent-runner-e2e-"))
  const name = `e2e-${word}`
  let runner: ChildProcess | undefined
  const proxy = await relay()
  const frames = transcriptFrames(page)
  try {
    await step("An Admin registers a runner and names the coding agent", async () => {
      const sha = execFileSync(process.execPath, [smthrs, "runner", "token", "--state", state], { encoding: "utf8" }).trim()
      await page.goto(`/${repo}/stack`)
      await adminWrite(page, `runners/${name}`, "PUT", { tokenSha256: sha, labels: ["e2e"], capacity: 1 })
      await adminWrite(page, `agents/${name}`, "PUT", { labels: ["e2e"], profile: "acp-test", coding: true })
      const config = {
        // Through the spec's relay, so the spec can refuse the runner's transcript posts for a minute.
        origin: proxy.origin,
        name,
        capacity: 1,
        stateDir: state,
        repositories: { [`github/${repo.toLowerCase()}`]: { mirror: process.env.E2E_RUNNER_MIRROR! } },
        profiles: { "acp-test": { argv: [process.execPath, testAgent], env: { ACP_TEST_AGENT_STATE: join(state, "agent") } } },
      }
      writeFileSync(join(state, "runner.json"), JSON.stringify(config))
      runner = spawn(process.execPath, [smthrs, "runner", "serve", "--config", join(state, "runner.json")], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: new URL(baseURL).hostname === "localhost" ? "0" : "1" },
      })
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

    const row = page.getByRole("region", { name: `${repo} stack` }).locator("[data-slot=issues-row]", { hasText: word })
    await step("The runner's agent works on it", async () => {
      await expect(row).toHaveAttribute("data-status", /running|in_review/, { timeout: 60_000 })
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
      await expect(row).toHaveAttribute("data-status", "in_review", { timeout: 10 * 60_000 })
      const number = (await row.textContent())!.match(/T(\d+)/)![1]!
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
  } finally {
    // The repository codes with Smithers' own agent again, and the runner is retired.
    await adminWrite(page, `agents/${name}`, "DELETE").catch(() => undefined)
    await adminWrite(page, `runners/${name}`, "DELETE").catch(() => undefined)
    runner?.kill("SIGTERM")
    const stderr = runner?.stderr?.read()?.toString() ?? ""
    if (test.info().status !== test.info().expectedStatus) test.info().attach("runner.log", { body: stderr })
    rmSync(state, { recursive: true, force: true })
    proxy.server.close()
  }
})
