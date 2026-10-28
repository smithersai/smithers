// The first run on a tab (decision 0121, docs/features/first-run.md), driven as React drives it: the first run's live
// row and the list's press, with no React. Each tab runs the browser's own layer (`appLayer`) on a Node device against
// ChatApi's real handler over the compose Postgres and Electric (src/test/chatApi.ts): who is signed in comes from
// sign-in's real session route, a person's model from your model's real save and shape, their conversations from the
// real `my-conversations` shape. A follower that stops is the one unhappy path; the tab's own session row going missing,
// which nothing does, stops it.
import { Effect, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import { OPENAI_ORIGIN } from "../../../worker/personal/test/provider.ts"
import { member, nodeDevice, openTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { read } from "../../test/otlp"
import { AuthStore, SESSION } from "../auth/store"
import { Chat } from "../chat/chat"
import { PersonalModel } from "../personal-model/personalModel"
import { FirstRun } from "./firstRun"
import { presses, steps } from "./metrics"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

/** How long Electric, a save's flow or a sign-in check may take on a loaded machine. */
const until = (assertion: () => void | Promise<void>, timeout = 40_000) => vi.waitFor(assertion, { timeout, interval: 20 })

/** A test's budget: fresh devices, their sign-in, their first syncs and a save, on a loaded machine. */
const WITHIN = 120_000

const guest: Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest" }

/** ChatApi as `actor` (a Member unless set, nobody with `null`), from a first tab whose engine never leads. */
const openApi = async (actor?: Actor | null) => {
  const app = openTestApp({ answers: false }, actor === undefined ? {} : { actor })
  runtimes.push(app)
  return { api: await app.runPromise(Effect.service(TestChatApi)), app }
}

/** Turns the deployment's own model off, as an Admin's setting does (decision 0099); the test ChatApi has it on. */
const hostedOff = (opened: Awaited<ReturnType<typeof openApi>>) =>
  opened.app.runPromise(
    opened.api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`INSERT INTO hosted_model (enabled, updated_by) VALUES (false, 'person-admin')`)),
  )

/** A tab on `api`, on `host` (a device of its own unless set), its first run's row live as React reads it. */
const openFirstRun = async (api: TestChatApi["Service"], host = nodeDevice()) => {
  const runtime = openTab(api, { host })
  runtimes.push(runtime)
  const firstRun = await runtime.runPromise(Effect.service(FirstRun))
  const chat = await runtime.runPromise(Effect.service(Chat))
  const personalModel = await runtime.runPromise(Effect.service(PersonalModel))
  firstRun.queries.state.startSyncImmediate()
  personalModel.queries.saved.startSyncImmediate()
  const now = () => firstRun.queries.state.toArray[0]!
  return {
    runtime,
    chat,
    personalModel,
    press: firstRun.actions.press,
    now,
    /** The steps as `id:state`, in order. */
    steps: () => now().steps.map((step) => `${step.id}:${step.state}`),
    count: (metric: typeof steps, attributes: Record<string, string>) =>
      runtime.runSync(Metric.value(Metric.withAttributes(metric, attributes))).count,
  }
}

describe("a visitor's first page", () => {
  test("is Sign in, with as many steps as they will have signed in: Add your model only while the deployment's is off", async () => {
    const opened = await openApi(null)
    const tab = await openFirstRun(opened.api)
    await until(() => expect(tab.now()).toMatchObject({ show: "steps", at: "sign_in" }))
    expect(tab.steps()).toEqual(["sign_in:next", "ask:later"])

    await hostedOff(opened)
    const later = await openFirstRun(opened.api)
    await until(() => expect(later.now()).toMatchObject({ show: "steps", at: "sign_in" }))
    expect(later.steps()).toEqual(["sign_in:next", "model:later", "ask:later"])
    // Each tab counts the step it showed, once.
    expect(tab.count(steps, { step: "sign_in" })).toBe(1)
    expect(later.count(steps, { step: "sign_in" })).toBe(1)

    // Its records name the step and how many there are, nothing a person typed.
    await later.runtime.dispose()
    await tab.runtime.dispose()
    const records = read(opened.api.telemetry)
    expect(records.log("first_run.step").map((line) => line.attributes)).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: "sign_in", steps: 2, feature: "first-run" }),
      expect.objectContaining({ step: "sign_in", steps: 3, feature: "first-run" }),
    ]))
    expect(records.span("first_run.step")).toContainEqual(
      expect.objectContaining({ attributes: expect.objectContaining({ step: "sign_in", steps: 3 }) }),
    )
    expect(records.point("smithers_web_first_run_steps", { step: "sign_in" })?.value).toBeGreaterThan(0)
  }, WITHIN)
})

describe("a signed-in person's first page", () => {
  test("a Guest of the deployment's repository adds their model, then is at Open your repository, never stopped (ruling AUTH-8)", async () => {
    // The deployment's model is on, but answers only its own Members: a Guest needs a model of their own.
    const opened = await openApi(guest)
    const tab = await openFirstRun(opened.api)
    await until(() => expect(tab.now()).toMatchObject({ show: "steps", at: "model" }))
    expect(tab.steps()).toEqual(["sign_in:done", "model:next", "repository:later"])
    expect(tab.personalModel.actions.save({
      keys: [{ protocol: "openai-chat", baseUrl: `${OPENAI_ORIGIN}/v1/`, key: "sk-first-run-guest-0123456789" }],
      models: { fast: { protocol: "openai-chat", modelId: "gpt-test" } },
    })).toBe(true)
    await until(() => expect(tab.now()).toMatchObject({ show: "steps", at: "repository" }))
    expect(tab.steps()).toEqual(["sign_in:done", "model:done", "repository:next"])
    // Open is the first run's own press.
    tab.press("repository")
    expect([tab.count(steps, { step: "model" }), tab.count(steps, { step: "repository" }), tab.count(presses, { step: "repository" })])
      .toEqual([1, 1, 1])
  }, WITHIN)

  test("with the deployment's model on, a Member is at Ask Smithers, Sign in done", async () => {
    const opened = await openApi()
    const tab = await openFirstRun(opened.api)
    await until(() => expect(tab.now()).toMatchObject({ show: "steps", at: "ask" }))
    expect(tab.steps()).toEqual(["sign_in:done", "ask:next"])
  }, WITHIN)

  test("a Member adds their model, opens the composer, asks, and the steps are gone for good", async () => {
    const opened = await openApi(member)
    await hostedOff(opened)
    // A device whose engine never leads: ChatApi takes a question, and nothing answers it.
    const host = nodeDevice()
    const tab = await openFirstRun(opened.api, host)
    await until(() => expect(tab.now()).toMatchObject({ show: "steps", at: "model" }))
    expect(tab.steps()).toEqual(["sign_in:done", "model:next", "ask:later"])

    // Open settings from the list is the first run's own press.
    tab.press("model")
    expect(tab.count(presses, { step: "model" })).toBe(1)

    // Saved through Settings: the row syncs back, and the person is at Ask Smithers.
    expect(tab.personalModel.actions.save({
      keys: [{ protocol: "openai-chat", baseUrl: `${OPENAI_ORIGIN}/v1/`, key: "sk-first-run-0123456789" }],
      models: { fast: { protocol: "openai-chat", modelId: "gpt-test" } },
    })).toBe(true)
    await until(() => expect(tab.now()).toMatchObject({ show: "steps", at: "ask" }))
    expect(tab.steps()).toEqual(["sign_in:done", "model:done", "ask:next"])

    // Chat ⌘K opens the composer in the list's place; hiding it brings the step back.
    tab.chat.actions.openComposer("button")
    await until(() => expect(tab.now().show).toBe("hidden"))
    tab.chat.actions.closeComposer()
    await until(() => expect(tab.now()).toMatchObject({ show: "steps", at: "ask" }))

    // Their first question: ChatApi takes it into the home conversation, which joins their conversations, so the steps go.
    expect((await tab.chat.actions.ask("Hello Smithers")).asked).toBe(true)
    await until(() => expect(tab.now().show).toBe("hidden"))
    expect([tab.count(steps, { step: "model" }), tab.count(steps, { step: "ask" })]).toEqual([1, 2])

    // Another tab of theirs restores the conversation from the device: never the steps again.
    const again = await openFirstRun(opened.api, host)
    await until(() => expect(again.now().show).toBe("hidden"))
    expect(again.count(steps, { step: "ask" })).toBe(0)

    await again.runtime.dispose()
    await tab.runtime.dispose()
    const records = read(opened.api.telemetry)
    expect(records.log("first_run.press").map((line) => line.attributes)).toContainEqual(
      expect.objectContaining({ step: "model", feature: "first-run" }),
    )
    expect(records.span("first_run.press")).toContainEqual(expect.objectContaining({ attributes: expect.objectContaining({ step: "model" }) }))
    expect(records.point("smithers_web_first_run_presses", { step: "model" })?.value).toBeGreaterThan(0)
    // No key, no question and no login rides in the first run's records.
    expect(JSON.stringify([records.log("first_run.step"), records.log("first_run.press")])).not.toMatch(/sk-first-run|Hello Smithers|person-member/)
  }, WITHIN)
})

test("should the follower stop, the composer's place shows the gate, and the stop is recorded", async () => {
  const opened = await openApi()
  const tab = await openFirstRun(opened.api)
  await until(() => expect(tab.now()).toMatchObject({ show: "steps", at: "ask" }))
  // Nothing deletes the tab's session row; doing it makes the follower's next read fail.
  const auth = await tab.runtime.runPromise(Effect.service(AuthStore))
  await tab.runtime.runPromise(auth.session.delete(SESSION))
  await until(() => expect(tab.now().show).toBe("hidden"))
  await tab.runtime.dispose()
  expect(read(opened.api.telemetry).log("app.unhandled").map((line) => line.attributes)).toContainEqual(
    expect.objectContaining({ feature: "first-run", boundary: "fork", kind: "defect" }),
  )
}, WITHIN)
