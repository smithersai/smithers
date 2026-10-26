import type { Page } from "@playwright/test"
import { expect, test } from "./devices"
import { step } from "./fixtures"
import { requires, scriptedAgent } from "./target"
import { expectServerError } from "./watch"

// Run credentials, end to end (decision 0017 slice 0, docs/features/sign-in.md#run-credentials): the server tells the
// person from the agent. The agent asks the person a question (`app/agent/ask`, the scripted agent in the asking
// browser's engine worker, `/app?agent=needs-you`, src/test/scriptedAgent.ts). Then the agent's own credential, minted
// for its run exactly as the engine mints it, tries to answer for the person: the server refuses it, both directly and as
// a nested call's credential, and the question stays open. The person's own press answers it, and the agent goes on.
// Everything is real: the engine, ChatApi, the runs routes, Postgres and Electric. The scripted model is a dev build's,
// and asking needs a Member or above.
requires("scriptedAgent", "member")

const PROMPT = "Which branch should I deploy?"

/** What a request the page sends answers: its status and its body. */
const send = (page: Page, path: string, body: unknown, token?: string) =>
  page.evaluate(
    async ({ path, body, token }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
        // A run's requests never carry the person's cookie; the engine sends them the same way.
        credentials: token === undefined ? "same-origin" : "omit",
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    },
    { path, body, token },
  )

test("the agent's credential can't answer for the person; the person's own press does", async ({ devices }) => {
  test.setTimeout(240_000)
  // The refusals this test asks for, which Chrome reports as console errors.
  expectServerError(403, "/api/runs/*/answer")
  expectServerError(403, "/api/runs/*/credential")
  const [a] = await devices.open("A")
  await a.page.goto(scriptedAgent("needs-you"))
  await a.ready()
  const question = `Deploy the docs preview, ${devices.word}`
  await a.askAndWaitTaken(question)
  const answerId = a.asked.find((asked) => asked.text === question)!.answerId
  const card = a.page.locator(`[data-slot="needs-you"][data-run="${answerId}"]`)
  await expect(card, "the agent asks").toBeVisible({ timeout: 60_000 })
  await expect(card).toHaveAccessibleName(PROMPT)

  const token = await step("the agent's run gets its credential", async () => {
    const minted = await send(a.page, `/api/runs/${answerId}/credential`, { flow: "chat/Answer" })
    expect(minted).toMatchObject({ status: 200, body: { act: "agent", token: expect.any(String) } })
    return minted.body.token as string
  })

  await step("the agent answers for the person: refused", async () => {
    const answer = { version: 1, value: "docs-v2" }
    expect(await send(a.page, `/api/runs/${answerId}/answer`, answer, token)).toEqual({
      status: 403,
      body: { code: "person_only" },
    })
    // Nor does a call nested in the agent's run get a credential for it.
    expect(await send(a.page, `/api/runs/${encodeURIComponent(`${answerId}/call/9.9`)}/credential`, { flow: "run/answer" }, token))
      .toEqual({ status: 403, body: { code: "person_only" } })
    await expect(card, "the question is still open").not.toHaveAttribute("data-state", "answered")
  })

  await step("the person answers", async () => {
    await card.getByRole("button", { name: "docs-v2" }).click()
    // The agent goes on with the person's answer, which the server recorded as theirs: the same answer again is taken
    // as landed, while the agent's credential is still refused.
    await a.expectAnswered(question, "Deploying docs-v2.", 120_000)
    expect(await send(a.page, `/api/runs/${answerId}/answer`, { version: 1, value: "docs-v2" })).toEqual({
      status: 200,
      body: { txid: null },
    })
    expect(await send(a.page, `/api/runs/${answerId}/answer`, { version: 1, value: "docs-v2" }, token)).toEqual({
      status: 403,
      body: { code: "person_only" },
    })
  })
})
