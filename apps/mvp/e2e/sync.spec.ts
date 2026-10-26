import { expect, expectSameThread, test } from "./devices"
import { step } from "./fixtures"
import { requires, scriptedAgent } from "./target"

// Both tests ask, which needs a Member or above.
requires("personalModel", "member", "ownConversation")

// Two separate browsers hold the conversation Electric syncs from Postgres; the asking browser's agent answers.
test("sync: a message and Smithers' answer sent in one browser appear in another", { annotation: { type: "summary", description: "A question and its answer from one browser show in another." } }, async ({ devices }) => {
  requires("liveModel")
  const word = devices.word
  const [alice, bob] = await devices.open("Alice", "Bob")
  const question = `Reply with exactly the word: sync-${word}`
  await alice.ask(question)
  await bob.expectAnswered(question, `sync-${word}`)
  await alice.expectAnswered(question, `sync-${word}`)
  await expectSameThread([alice, bob], word, 2)
})

/**
 * How long another device may take to show a write. Over HTTP/2 every shape's long poll waits at Electric at once, so
 * a change comes back with the next response; over the dev server's plain HTTP/1.1 a tab's shapes queued for its six
 * connections, and a change waited up to 40 s (docs/infrastructure.md#https-and-http2).
 */
const SYNCED_WITHIN = 10_000

// Model-free: A's agent is the scripted one (`/app?agent=needs-you`, src/test/scriptedAgent.ts), which asks every time.
test("sync over HTTP/2: every shape waits at once, so another device shows a write within seconds", async ({ devices }) => {
  requires("scriptedAgent")
  const word = devices.word
  const [a, b] = await devices.open("A", "B")
  await step("A runs the scripted agent", async () => {
    await a.page.goto(scriptedAgent("needs-you"))
    await a.ready()
  })

  // The protocol each shape response came over, from Chromium's network log: HTTP/2 (HTTP/3 on Cloudflare), as in
  // production, where one connection carries every shape's long poll.
  const protocols = new Map<string, Array<string>>()
  for (const tab of [a, b]) {
    const seen: Array<string> = []
    protocols.set(tab.name, seen)
    const network = await tab.page.context().newCDPSession(tab.page)
    network.on("Network.responseReceived", ({ response }) => {
      if (new URL(response.url).pathname.startsWith("/api/shapes/")) seen.push(response.protocol ?? "unknown")
    })
    await network.send("Network.enable")
  }

  const question = `Deploy the docs preview, ${word}`
  await a.askAndWaitTaken(question)
  const taken = Date.now()
  await expect(b.question(question), "B shows A's question within seconds").toHaveCount(1, { timeout: SYNCED_WITHIN })
  test.info().annotations.push({ type: "synced", description: `B showed A's question ${Date.now() - taken} ms after ChatApi took it` })
  for (const [name, seen] of protocols) {
    await expect.poll(() => seen.length, { message: `${name} got shape responses` }).toBeGreaterThan(0)
    expect(seen.filter((protocol) => !/^h[23]$/.test(protocol)), `${name}'s shapes all speak HTTP/2`).toEqual([])
  }

  // B answers the agent's question; A's engine gets it through sync, and its agent finishes on both devices.
  const answerId = a.asked.find((asked) => asked.text === question)!.answerId
  const field = b.page.locator(`[data-slot="needs-you"][data-run="${answerId}"]`).getByRole("textbox", { name: "Your answer" })
  await expect(field, "B shows the agent's question").toBeVisible({ timeout: SYNCED_WITHIN })
  await field.fill("docs-v2")
  await field.press("Enter")
  for (const tab of [a, b]) await tab.expectAnswered(question, "Deploying docs-v2.", 30_000)
})
