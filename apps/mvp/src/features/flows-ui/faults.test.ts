// Your own flows and runs from a tab whose engine refuses what it is asked to start (src/test/faults.ts `EngineFaults`,
// test.faults-by-injection): nothing opens a page for a run that never started, unsent answers stay, a refused Save
// says it couldn't, and a refused act on a run says it was refused. Everything else is the real app.
import { ShapeSource } from "@smthrs/effect-electric"
import { BrowserEngine } from "@smthrs/platform-browser"
import { Effect, Layer, Logger, ManagedRuntime, Metric, References } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { nodeDevice, openFaultyApp, openFaultyTab, type TabOptions, TestChatApi } from "../../test/chatApi"
import { read } from "../../test/otlp"
import { EngineFaults } from "../../test/faults"
import { dispatches } from "../../flows/dispatch"
import { Runs } from "../runs/runs"
import { codePath, draftPath, FLOWS_PATH, SAVE_REFUSALS } from "./contract"
import { draftAgain } from "./actions"
import { FlowsUiStore, SHOWN } from "./store"
import { FlowsUi } from "./flowsUi"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>, timeout = 60_000) => vi.waitFor(assertion, { timeout, interval: 25 })

const drafted = {
  description: "Say hello.",
  instructions: "Say hello.",
  flows: [],
  questions: [{ text: "Which greeting?", assumed: "Hello", blocking: false }],
  summary: "Says hello.",
}

const open = async (options: TabOptions = {}, route?: { current: string }) => {
  const app = openFaultyApp()
  runtimes.push(app)
  const api = await app.runPromise(Effect.service(TestChatApi))
  const host = nodeDevice({ agent: api, ...(route === undefined ? {} : { pathname: () => route.current }) })
  const tab = openFaultyTab(
    api,
    { ...options, host },
  )
  runtimes.push(tab)
  const flows = await tab.runPromise(Effect.service(FlowsUi))
  const runs = await tab.runPromise(Effect.service(Runs))
  const faults = await tab.runPromise(Effect.service(EngineFaults))
  const shapes = await tab.runPromise(Effect.service(ShapeSource.Faults))
  for (const query of [...Object.values(flows.queries), ...Object.values(runs.queries)]) query.startSyncImmediate()
  return {
    api,
    tab,
    standalone: async () => {
      const runtime = ManagedRuntime.make(FlowsUiStore.layer({ origin: api.origin, editorTabId: host.editorTabId, editorTabPersistent: host.editorTabPersistent }).pipe(Layer.provideMerge(Layer.succeedContext(await tab.context()))))
      runtimes.push(runtime)
      return { runtime, store: await runtime.runPromise(Effect.service(FlowsUiStore)) }
    },
    host,
    flows,
    runs,
    shapes: (fault: Effect.Effect<void>) => tab.runPromise(fault),
    stall: shapes.stall("live"),
    heal: shapes.heal,
    /** How many runs of `flow` this tab's engine finished. */
    done: (flow: string) =>
      tab.runSync(Metric.value(Metric.withAttributes(dispatches, { flow, door: "button", outcome: "done" }))).count,
    refuse: (flow: string) => tab.runPromise(faults.refuseStarts(flow)),
    /** How many dispatches of `flow` this tab made that the engine never ran. */
    refused: (flow: string) =>
      tab.runSync(Metric.value(Metric.withAttributes(dispatches, { flow, door: "button", outcome: "error" }))).count,
    reply: async (task: string, source: string) => (await app.runPromise(api.answerTo(task))).cell(source),
  }
}

describe("an engine that refuses a start", () => {
  test("nothing opens, answers stay, Save says it couldn't, and an act on a run says the same", async () => {
    const t = await open()
    // No draft shown: Answer and Save do nothing.
    t.flows.actions.answer()
    t.flows.actions.save()
    t.flows.actions.draftAgain()
    const isolated = await t.standalone()
    const { store } = isolated
    await isolated.runtime.runPromise(store.readRound)

    // A draft, then each act refused.
    t.flows.actions.setName("hello")
    t.flows.actions.setRequest("Say hello")
    await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "hello" }))
    t.flows.actions.startDraft()
    await until(() => expect(t.host.navigated.some((path) => path.startsWith("/app/flows/drafts/"))).toBe(true))
    const draftId = t.host.navigated.find((path) => path.startsWith("/app/flows/drafts/"))!.split("/").at(-1)!
    await t.reply("The flow's name: hello", `ctx.done(${JSON.stringify(drafted)})`)
    await t.flows.actions.openDraft(draftId)
    await until(() => expect(t.flows.queries.draft.toArray[0]?.draft.status).toBe("ready"))

    // Unchanged optional answers do not launch another round.
    t.flows.actions.answer()
    await t.tab.runPromise(Effect.yieldNow)
    expect(t.done("flow/answer")).toBe(0)
    await isolated.runtime.runPromise(store.drafts.preload)
    await isolated.runtime.runPromise(store.shown.update(SHOWN, (row) => { row.draftId = draftId }))
    for (const state of ["Pending", "Unreadable"] as const) {
      await isolated.runtime.runPromise(draftAgain.pipe(Effect.provideService(FlowsUiStore, { ...store,
        nextRound: () => Effect.succeed({ _tag: state, round: 1 }),
      })))
    }
    expect((await isolated.runtime.runPromise(store.shown.get(SHOWN)))).toMatchObject({ value: { refusal: "again_unavailable" } })

    await t.refuse("flow/answer")
    t.flows.actions.setAnswer(draftId, "r0q1", "Hi")
    await until(() => expect(t.flows.queries.answers.toArray).toHaveLength(1))
    t.flows.actions.answer()
    await until(() => expect(t.refused("flow/answer")).toBe(1))
    expect(t.flows.queries.answers.toArray).toHaveLength(1)

    await t.refuse("flow/save")
    t.flows.actions.save()
    await until(() => expect(t.flows.queries.draft.toArray[0]?.shown).toMatchObject({ busy: false, refusal: "unavailable" }))

    await t.refuse("flow/new")
    const before = t.host.navigated.length
    t.flows.actions.setName("again")
    t.flows.actions.setRequest("Say hello again")
    await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "again" }))
    t.flows.actions.startDraft()
    await t.refuse("flow/run")
    t.flows.actions.run("hello", 1)
    await until(() => expect([t.refused("flow/new"), t.refused("flow/run")]).toEqual([1, 1]))
    expect(t.host.navigated).toHaveLength(before)
  }, 180_000)

  test("a round whose checks fail is Failed, Save's own refusal reads by its code, and Draft again and Delete the engine won't start say they couldn't", async () => {
    const t = await open()
    t.flows.actions.setName("hello")
    t.flows.actions.setRequest("Say hello")
    await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "hello" }))
    t.flows.actions.startDraft()
    await until(() => expect(t.host.navigated.some((path) => path.startsWith("/app/flows/drafts/"))).toBe(true))
    const draftId = t.host.navigated.find((path) => path.startsWith("/app/flows/drafts/"))!.split("/").at(-1)!
    // The agent's draft lists a flow nobody may call: the checks fail, the round fails `checks`, and Save is refused.
    await t.reply("The flow's name: hello", `ctx.done(${JSON.stringify({ ...drafted, flows: ["repo/write"] })})`)
    await t.flows.actions.openDraft(draftId)
    await until(() => expect(t.flows.queries.draft.toArray[0]?.draft).toMatchObject({ status: "failed", failure: "checks" }))
    t.flows.actions.save()
    await until(() => expect(t.flows.queries.draft.toArray[0]?.shown).toMatchObject({ busy: false, refusal: "not_ready" }))

    await t.refuse("flow/new")
    t.flows.actions.draftAgain()
    await until(() => expect(t.flows.queries.draft.toArray[0]?.shown.refusal).toBe("again_unavailable"))
    expect(SAVE_REFUSALS.again_unavailable).toBe("Couldn't start. Try again.")

    await t.refuse("flow/draft/delete")
    t.flows.actions.deleteDraft(draftId)
    await until(() => expect(t.flows.queries.draft.toArray[0]?.shown.refusal).toBe("delete_unavailable"))
    // A draft deleted from the list while another shows leaves the shown card's line alone.
    await t.flows.actions.openDraft(draftId)
    t.flows.actions.deleteDraft(crypto.randomUUID())
    await until(() => expect(t.refused("flow/draft/delete")).toBe(2))
    expect(t.flows.queries.draft.toArray[0]?.shown.refusal).toBeNull()
    expect(t.flows.queries.drafts.toArray.map((draft) => draft.id)).toEqual([draftId])
  }, 180_000)

  test("a refused code read preserves unsaved edits with a refusal, and an untouched editor is unavailable", async () => {
    const t = await open()
    await readyDraft(t)
    t.flows.actions.save()
    await until(() => expect(t.flows.queries.flows.toArray.map((flow) => flow.name)).toEqual(["hello"]))
    await t.flows.actions.openCode("hello")
    expect(t.flows.queries.code.toArray[0]).toMatchObject({ state: "read", revision: 1 })
    const source = t.flows.queries.code.toArray[0]!.text
    const edited = `${source}// mine\n`
    await t.refuse("flow/write")
    t.flows.actions.editCode("hello", edited)
    await until(() => expect(t.flows.queries.code.toArray[0]?.text).toBe(edited))
    t.flows.actions.saveCode()
    await until(() => expect(t.flows.queries.code.toArray[0]).toMatchObject({ busy: false, refusal: "unavailable" }))
    expect(t.refused("flow/write")).toBe(1)
    await t.refuse("flow/read")
    await t.flows.actions.openCode("hello")
    // 4a6932b4 / decision 0092: an unreadable revision keeps unsaved text visible with a refusal.
    expect(t.flows.queries.code.toArray[0]).toMatchObject({
      name: "hello", state: "read", revision: 1, source, text: edited, busy: false, refusal: "unavailable",
    })
    expect(t.refused("flow/read")).toBe(1)
    // Without an unsaved edit, a failed read still makes the editor unavailable.
    t.flows.actions.editCode("hello", source)
    await until(() => expect(t.flows.queries.code.toArray[0]?.text).toBe(source))
    await t.flows.actions.openCode("hello")
    expect(t.flows.queries.code.toArray[0]).toMatchObject({
      name: "hello", state: "unavailable", revision: 0, source: "", text: "",
    })
    expect(t.refused("flow/read")).toBe(2)
  }, 180_000)

  test("an act on a run the engine refuses to start says it was refused", async () => {
    const t = await open()
    t.flows.actions.setName("hello")
    t.flows.actions.setRequest("Say hello")
    await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "hello" }))
    t.flows.actions.startDraft()
    await until(() => expect(t.host.navigated.some((path) => path.startsWith("/app/flows/drafts/"))).toBe(true))
    const draftId = t.host.navigated.find((path) => path.startsWith("/app/flows/drafts/"))!.split("/").at(-1)!
    await t.reply("The flow's name: hello", `ctx.done(${JSON.stringify(drafted)})`)
    // The draft's round is a run of this device: its page reads it, and Stop on it is refused at the start.
    await t.runs.actions.openRun(`${draftId}:0`)
    await until(() => expect(t.runs.queries.page.toArray[0]?.page.state).toBe("read"))
    await t.refuse("run/retry")
    t.runs.actions.retry("pinned")
    // A refused start reads as refused, not as an engine that couldn't be reached.
    await until(() => expect(t.runs.queries.page.toArray[0]?.view).toMatchObject({ acting: null, refusal: "refused" }))
  }, 180_000)
})

/** Drafts `hello` from the form to ready, and shows it. */
const readyDraft = async (t: Awaited<ReturnType<typeof open>>) => {
  t.flows.actions.setName("hello")
  t.flows.actions.setRequest("Say hello")
  await until(() => expect(t.flows.queries.form.toArray[0]).toMatchObject({ name: "hello" }))
  t.flows.actions.startDraft()
  await until(() => expect(t.host.navigated.some((path) => path.startsWith("/app/flows/drafts/"))).toBe(true))
  const draftId = t.host.navigated.find((path) => path.startsWith("/app/flows/drafts/"))!.split("/").at(-1)!
  await t.reply("The flow's name: hello", `ctx.done(${JSON.stringify(drafted)})`)
  await t.flows.actions.openDraft(draftId)
  await until(() => expect(t.flows.queries.draft.toArray[0]?.draft.status).toBe("ready"))
}

describe("an engine that can't be read", () => {
  test("a round it refuses to read is unreadable, logged once by the engine's code; one it never held is absent, unlogged", async () => {
    const t = await open()
    const real = await t.tab.runPromise(Effect.service(BrowserEngine.BrowserEngine))
    /** The store over this tab's services, with an engine whose every read fails with `failure`. */
    const failing = async (failure: BrowserEngine.RequestRefused | BrowserEngine.EngineUnavailable) => {
      const engine = BrowserEngine.BrowserEngine.of({ ...real, inspect: () => Effect.fail(failure) })
      const runtime = ManagedRuntime.make(
        FlowsUiStore.layer({ origin: t.api.origin, editorTabId: t.host.editorTabId, editorTabPersistent: t.host.editorTabPersistent }).pipe(
          Layer.provide(Layer.succeed(BrowserEngine.BrowserEngine, engine)),
          Layer.provideMerge(Layer.succeedContext(await t.tab.context())),
        ),
      )
      runtimes.push(runtime)
      return { store: await runtime.runPromise(Effect.service(FlowsUiStore)), close: () => runtime.dispose() }
    }
    const refusing = (error: string) => failing(new BrowserEngine.RequestRefused({ request: "Inspect", error }))
    const lines: Array<{ readonly message: unknown; readonly level: string; readonly annotations: unknown }> = []
    const logger = Logger.make(({ message, logLevel, fiber }) =>
      void lines.push({ message: (message as ReadonlyArray<unknown>)[0], level: logLevel, annotations: fiber.getRef(References.CurrentLogAnnotations) }))
    const recorded = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([logger]))))

    const broken = await refusing("@smthrs/engine-store/SqlError")
    expect(await recorded(broken.store.nextRound("d", 0))).toEqual({ _tag: "Unreadable" })
    await broken.close()
    expect(lines).toEqual([{
      message: "flows.round.inspect",
      level: "Warn",
      annotations: { feature: "flows", outcome: "unreadable", errorCode: "@smthrs/engine-store/SqlError" },
    }])

    lines.length = 0
    const empty = await refusing("@smthrs/engine-store/RunNotFound")
    expect(await recorded(empty.store.nextRound("d", 0))).toEqual({ _tag: "Start", round: 1 })
    expect(lines).toEqual([])

    // An engine that is gone is unreadable too, by the failure's own tag.
    const gone = await failing(new BrowserEngine.EngineUnavailable({ reason: "worker-failed", error: "TypeError" }))
    expect(await recorded(gone.store.nextRound("d", 0))).toEqual({ _tag: "Unreadable" })
    await gone.close()
    expect(lines).toEqual([{
      message: "flows.round.inspect",
      level: "Warn",
      annotations: { feature: "flows", outcome: "unreadable", errorCode: "@smthrs/platform-browser/EngineUnavailable" },
    }])
  }, 120_000)
})

describe("Electric slow to deliver the saved flow", () => {
  test("draft Save finishing after leaving its page does not redirect the person", async () => {
    const route = { current: "/app/flows" }
    const t = await open({}, route)
    await readyDraft(t)
    const draftId = t.flows.queries.draft.toArray[0]!.draft.id
    route.current = draftPath(draftId)
    await t.shapes(t.stall)
    const priorListOpens = t.host.navigated.filter((path) => path === FLOWS_PATH).length
    t.flows.actions.save()
    await until(() => expect(t.done("flow/save")).toBe(1))
    route.current = "/app/conversations"
    await t.shapes(t.heal)
    await until(() => expect(t.flows.queries.draft.toArray[0]?.shown.busy).toBe(false))
    expect(t.host.navigated.filter((path) => path === FLOWS_PATH)).toHaveLength(priorListOpens)
  }, 180_000)

  test("a code save finishing after the person leaves Code does not redirect them", async () => {
    const route = { current: codePath("hello") }
    const t = await open({}, route)
    await readyDraft(t)
    t.flows.actions.save()
    await until(() => expect(t.flows.queries.flows.toArray[0]).toMatchObject({ name: "hello", revision: 1 }))
    await t.flows.actions.openCode("hello")
    const source = t.flows.queries.code.toArray[0]!.text
    t.flows.actions.editCode("hello", `${source}\n// mine`)
    await until(() => expect(t.flows.queries.code.toArray[0]?.text).toBe(`${source}\n// mine`))
    await t.shapes(t.stall)
    const priorListOpens = t.host.navigated.filter((path) => path === FLOWS_PATH).length
    const saving = t.flows.actions.saveCode()
    await until(() => expect(t.done("flow/write")).toBe(1))
    route.current = "/app/conversations"
    await t.shapes(t.heal)
    await saving
    expect(t.host.navigated.filter((path) => path === FLOWS_PATH)).toHaveLength(priorListOpens)
  }, 180_000)

  test("a code save finishing after navigation leaves the next flow's editor alone", async () => {
    const t = await open()
    await readyDraft(t)
    t.flows.actions.save()
    await until(() => expect(t.flows.queries.flows.toArray[0]).toMatchObject({ name: "hello", revision: 1 }))
    await t.flows.actions.openCode("hello")
    const source = t.flows.queries.code.toArray[0]!.text
    t.flows.actions.editCode("hello", `${source}\n// mine`)
    await until(() => expect(t.flows.queries.code.toArray[0]?.text).toBe(`${source}\n// mine`))
    await t.shapes(t.stall)
    const priorListOpens = t.host.navigated.filter((path) => path === FLOWS_PATH).length
    const saving = t.flows.actions.saveCode()
    await until(() => expect(t.done("flow/write")).toBe(1))
    await t.flows.actions.openCode("nothing")
    expect(t.flows.queries.code.toArray[0]).toMatchObject({ name: "nothing", state: "not_found" })
    await t.shapes(t.heal)
    await saving
    expect(t.flows.queries.code.toArray[0]).toMatchObject({ name: "nothing", state: "not_found" })
    expect(t.host.navigated.filter((path) => path === FLOWS_PATH)).toHaveLength(priorListOpens)
  }, 180_000)

  test("Save opens the list only once this device has the flow", async () => {
    const t = await open()
    await readyDraft(t)
    await t.shapes(t.stall)
    t.flows.actions.save()
    // Saved, and still busy: the list waits for the flow.
    await until(() => expect(t.done("flow/save")).toBe(1))
    expect(t.flows.queries.draft.toArray[0]?.shown).toMatchObject({ busy: true, refusal: null })
    expect(t.host.navigated).not.toContain(FLOWS_PATH)
    await t.shapes(t.heal)
    await until(() => expect(t.host.navigated).toContain(FLOWS_PATH))
    expect(t.flows.queries.flows.toArray.map((flow) => flow.name)).toEqual(["hello"])
  }, 180_000)

  test("past confirmWithin the list opens anyway, and the save is logged unconfirmed", async () => {
    const t = await open({ confirmWithin: "1 second" })
    await readyDraft(t)
    await t.shapes(t.stall)
    t.flows.actions.save()
    await until(() => expect(t.host.navigated).toContain(FLOWS_PATH))
    expect(t.flows.queries.flows.toArray).toEqual([])
    expect(t.flows.queries.draft.toArray[0]?.shown).toMatchObject({ busy: false, refusal: null })
    for (const each of runtimes.splice(0).reverse()) await each.dispose()
    expect(read(t.api.telemetry).log("flow.save.unconfirmed")).toContainEqual(
      expect.objectContaining({ severity: "Warn", attributes: expect.objectContaining({ feature: "flows" }) }),
    )
  }, 180_000)
})
