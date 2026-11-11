import { readFileSync } from "node:fs"
import type { Page } from "@playwright/test"
import { DEV_ASK_TOKEN } from "../worker/AsksDev"
import { expect, test } from "./devices"
import { baseURL, requires, scriptedAgent, target } from "./target"

// The queue, end to end (decision 0022 slice 1, decision 0017 slice 1): a built-in plugin whose only wiring is its
// manifest (plugins/queue/plugin.json) and the public `PluginHost`. The agent asks three times; `g q` opens the queue;
// each wait fills the screen as its turn comes; the host's action strip answers it by key; the asking runs resume. The agent's
// model is scripted in the asking browser's engine worker (`/app?agent=queue`, src/test/scriptedAgent.ts); everything
// else is real: the plugin loader, the engine, ChatApi's runs routes, Postgres and Electric. It runs as local
// development's Maintainer, whom no other spec asks, so the queue holds only this test's waits. An agent with no person
// behind it asks the Maintainer too (docs/features/agent-status.md#addressed-waits), with `alchemy dev`'s development
// ask token (worker/AsksDev.ts) on the dev server's own repository.


const queue = (page: Page) => ({
  item: page.getByRole("article", { name: "Item" }),
  strip: page.getByRole("region", { name: "Actions" }),
  empty: page.getByText("Nothing needs you"),
})

/** Answers whatever an earlier, interrupted run of this test left waiting, so the queue starts empty. */
const drain = async (page: Page) => {
  const { item, strip } = queue(page)
  for (let left = 0; left < 20 && (await item.count()) > 0; left++) {
    if ((await item.getAttribute("data-kind")) === "approval") {
      await page.keyboard.press("a")
    } else {
      // Words answer any question, one with no options too (an agent's ask).
      await page.keyboard.press("i")
      await page.keyboard.type("drained")
      await page.keyboard.press("ControlOrMeta+Enter")
      await page.keyboard.press("Escape")
    }
    await expect(strip).not.toHaveAttribute("data-sending", "true", { timeout: 15_000 })
  }
}

test("queue: the agent asks three times, and the person answers each from the queue by keyboard", {
  annotation: { type: "summary", description: "A plugin's full-screen queue answers what the agent asked, one key at a time." },
}, async ({ devices }) => {
  requires("personalModel", "member", "ownConversation", "scriptedAgent", "devPeople")
  test.setTimeout(180_000)
  const word = devices.word
  const [a] = await devices.openAs("maintainer", "A")
  await a.page.goto(scriptedAgent("queue"))
  await a.ready()

  await test.step("Clear what an earlier run left", async () => {
    await a.page.keyboard.press("Escape")
    await a.page.keyboard.press("g")
    await a.page.keyboard.press("q")
    await expect(a.page).toHaveURL(/\/app\/queue$/)
    await expect(queue(a.page).item.or(queue(a.page).empty)).toBeVisible({ timeout: 15_000 })
    await drain(a.page)
    await expect(queue(a.page).empty).toBeVisible({ timeout: 15_000 })
    await a.page.getByRole("link", { name: "Back to chat" }).press("Enter")
    await expect(a.page).toHaveURL(/\/app$/)
  })

  // One conversation answers one question at a time: the second and third asks wait their turn, so each reaches the
  // queue once the one before it is answered.
  const asks = [`deploy ${word}-one`, `deploy ${word}-two`, `approve ${word}-three`]
  for (const ask of asks) await a.askAndWaitTaken(ask)
  // The run's question shows as its own card after the question it answers, named by the run (as status.spec.ts reads it).
  const first = a.asked.find((asked) => asked.text === asks[0])!.answerId
  await expect(a.page.locator(`[data-slot="needs-you"][data-run="${first}"]`)).toBeVisible({ timeout: 30_000 })
  await expect(a.page.getByRole("button", { name: /^Queue/ }).getByLabel("1 waiting")).toBeVisible({ timeout: 15_000 })

  const { item, strip, empty } = queue(a.page)
  await test.step("g q opens the queue at the first", async () => {
    // Out of the composer first: in a field, a letter is typing.
    await a.page.keyboard.press("Escape")
    await a.page.keyboard.press("g")
    await a.page.keyboard.press("q")
    await expect(a.page).toHaveURL(/\/app\/queue$/)
    await expect(item).toContainText("1 of 1")
    await expect(item).toContainText(`${word}-one`)
    await expect(strip.getByRole("button", { name: /docs-v2/ })).toBeVisible()
  })

  await test.step("2 answers it from the strip; the next arrives", async () => {
    await a.page.keyboard.press("2")
    await expect(item).toContainText(`${word}-two`, { timeout: 30_000 })
  })

  await test.step("1 answers that one", async () => {
    await a.page.keyboard.press("1")
    await expect(item).toHaveAttribute("data-kind", "approval", { timeout: 30_000 })
    await expect(item).toContainText(`${word}-three`)
  })

  await test.step("A note rides with the approval; the queue is empty", async () => {
    await a.page.keyboard.press("i")
    await expect(strip.getByRole("textbox", { name: "Note" })).toBeFocused()
    await a.page.keyboard.type("ship it")
    await a.page.keyboard.press("Escape")
    await a.page.keyboard.press("a")
    await expect(empty).toBeVisible({ timeout: 15_000 })
  })

  await test.step("Every asking run went on with its answer", async () => {
    await a.page.getByRole("link", { name: "Back to chat" }).press("Enter")
    await a.expectAnswered(asks[0]!, "Deploying docs-v2.")
    await a.expectAnswered(asks[1]!, "Deploying main.")
    await a.expectAnswered(asks[2]!, "Approved: ship it")
  })
})

/** Selects only this test's question; moving through the queue never answers another person's work. */
const focusAsk = async (page: Page, runId: string) => {
  await page.keyboard.press("Escape")
  await page.keyboard.press("g")
  await page.keyboard.press("q")
  await expect.poll(async () => {
    if (/^1 of /.test(await queue(page).item.locator(".queue-place").innerText())) return true
    await page.keyboard.press("k")
    return false
  }, { timeout: 30_000 }).toBe(true)
  await expect.poll(async () => {
    if (await queue(page).item.getAttribute("data-run").catch(() => null) === runId) return true
    await page.keyboard.press("j")
    return false
  }, { timeout: 30_000 }).toBe(true)
}

test("queue: an addressed question survives reload and offline use; a keyboard answer on another device resumes its run", {
  annotation: { type: "summary", description: "Two devices answer only this test's agent questions by key; the agent reads the answers." },
}, async ({ devices, playwright }) => {
  requires("askToken")
  test.setTimeout(180_000)
  const repository = target === "local"
    ? process.env.GITHUB_REPOSITORY ?? "smithersai/smithers"
    : process.env.E2E_ASK_REPOSITORY!
  const token = target === "local" ? DEV_ASK_TOKEN : readFileSync(process.env.E2E_MACHINE_TOKEN_FILE!, "utf8").trim()
  const word = devices.word
  const [a] = await devices.open("A")
  const [b] = await devices.open("B")
  const session = await a.page.request.get("/api/auth/session")
  expect(session.status()).toBe(200)
  const identity = await session.json()
  expect(identity.signedIn).toBe(true)
  expect(typeof identity.login).toBe("string")

  // No session cookies: the agent speaks through its scoped token alone.
  const agent = await playwright.request.newContext({ baseURL, ignoreHTTPSErrors: test.info().project.use.ignoreHTTPSErrors, storageState: { cookies: [], origins: [] } })
  const headers = { authorization: `Bearer ${token}` }
  const route = `/api/repos/${repository}/asks`
  const asks = [
    { id: `e2e-${word}-merge`, to: identity.login, prompt: `Merge ${word}'s docs preview?`, options: ["yes", "not yet"] },
    { id: `e2e-${word}-note`, to: identity.login, prompt: `What should ${word}'s release note say?` },
  ]
  const runs: Array<string> = []
  const readAsk = async (id: string) => {
    const response = await agent.get(`${route}/${id}`, { headers })
    expect(response.status()).toBe(200)
    return response.json()
  }
  try {
    await test.step("An agent asks twice", async () => {
      for (const ask of asks) {
        const response = await agent.post(route, { headers, data: ask })
        expect(response.status()).toBe(202)
        runs.push((await response.json()).runId)
      }
    })

    await test.step("Both devices show the question and its repository", async () => {
      for (const tab of [a, b]) {
        await focusAsk(tab.page, runs[0]!)
        await expect(queue(tab.page).item).toContainText(`${word}'s docs preview`)
        await expect(queue(tab.page).item).toContainText(repository.toLowerCase())
        await expect(queue(tab.page).strip.getByRole("button", { name: /not yet/ })).toBeVisible()
      }
    })

    await test.step("The first device reloads, then keeps its cached question offline", async () => {
      await a.page.reload()
      await expect(a.page.getByRole("main", { name: "Queue" })).toBeVisible({ timeout: 30_000 })
      await focusAsk(a.page, runs[0]!)
      await a.offline()
      await expect(queue(a.page).item).toContainText(`${word}'s docs preview`)
    })

    await test.step("1 on the second device answers the parked run", async () => {
      await b.page.keyboard.press("1")
      await expect.poll(() => readAsk(asks[0]!.id), { timeout: 30_000 })
        .toEqual({ status: "answered", answer: "yes", answeredAt: expect.any(String) })
      await expect(queue(b.page).item).not.toHaveAttribute("data-run", runs[0]!)
      await a.online()
      await expect(queue(a.page).item).not.toHaveAttribute("data-run", runs[0]!, { timeout: 30_000 })
    })

    await test.step("A note sent by key answers the second and syncs to both devices", async () => {
      await focusAsk(a.page, runs[1]!)
      await focusAsk(b.page, runs[1]!)
      await a.page.keyboard.press("i")
      await expect(queue(a.page).strip.getByRole("textbox", { name: "Note" })).toBeFocused()
      await a.page.keyboard.type("Docs land today")
      await a.page.keyboard.press("ControlOrMeta+Enter")
      await expect.poll(() => readAsk(asks[1]!.id), { timeout: 30_000 })
        .toEqual({ status: "answered", answer: "Docs land today", answeredAt: expect.any(String) })
      for (const tab of [a, b]) {
        await expect(queue(tab.page).item).not.toHaveAttribute("data-run", runs[1]!, { timeout: 30_000 })
      }
    })
  } finally {
    await agent.dispose()
  }
})
