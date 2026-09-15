import { expect, test } from "bun:test"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { createGuideController } from "./guide"
import type { ControllerContext } from "./context"

const setup = async (step: number, rawHttp: FetchLike) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step } }).isPersisted.promise
  const controller = createGuideController({ store, rawHttp, commandActor: "user" } as unknown as ControllerContext)
  return { store, controller }
}


test("only the current real signal completes a lesson; issue lists and issue flows are separate beats", async () => {
  const { store, controller } = await setup(3, fetch)
  await controller.guideAct("next")
  await controller.guideAct("signal", "file.opened")
  // Script v4: issues (beat 1) and issue flows (beat 3) no longer share one gate.
  await controller.guideAct("signal", "issues.opened")
  await controller.guideAct("advance", "0:3")
  expect(store.session().guide?.step).toBe(3)
  expect(store.session().guide?.completed).toEqual([])
  await controller.guideAct("signal", "issue.flows.opened")
  expect(store.session().guide?.completed).toEqual(["issue.flows.opened"])
  expect(store.session().guide?.step).toBe(3)
  await controller.guideAct("advance", "0:3")
  expect(store.session().guide?.step).toBe(4)
  await store.dispose?.()
})

test("Back pauses, stale timers cannot advance and replay clears completion", async () => {
  const { store, controller } = await setup(1, fetch)
  await controller.guideAct("back")
  await controller.guideAct("advance", "0:0")
  expect(store.session().guide?.step).toBe(1)
  await controller.guideAct("next")
  expect(store.session().guide?.step).toBe(1)
  await controller.guideAct("start")
  await controller.guideAct("advance", "0:0")
  expect(store.session().guide?.step).toBe(1)
  await controller.guideAct("signal", "identity.signed-in")
  await controller.guideAct("restart")
  await controller.guideAct("advance", "0:0")
  expect(store.session().guide?.step).toBe(1)
  expect(store.session().guide?.completed).toEqual(["tutorial.started"])
  expect(store.session().guide?.playthrough).toBe(1)
  await store.dispose?.()
})

test("theme and notification shortcuts do not complete repository lessons", async () => {
  const { store, controller } = await setup(2, fetch)
  await controller.guideAct("dark")
  expect(store.session().theme).toBe("dark")
  await controller.guideAct("notify")
  await controller.guideAct("notify")
  expect([...store.collections.toasts.values()].filter(t => t.key.startsWith("guide-hello-")).length).toBe(2)
  expect(store.session().guide?.completed).toEqual([])
  expect(store.session().guide?.step).toBe(2)
  await store.dispose?.()
})

test("entry initializes once and replay initializes a new playthrough without a gate or notification", async () => {
  const { store } = await setup(0, fetch)
  let starts = 0
  const controller = createGuideController({ store, rawHttp: fetch, commandActor: "user" } as unknown as ControllerContext, async () => { starts++ })
  await Promise.all([controller.guideAct("start"), controller.guideAct("start")])
  await controller.guideAct("start")
  expect(starts).toBe(1)
  expect(store.session().guide?.step).toBe(1)
  expect([...store.collections.toasts.values()].filter(toast => toast.key.startsWith("guide-tip-"))).toHaveLength(0)
  await controller.guideAct("restart")
  expect(starts).toBe(2)
  expect(store.session().guide).toMatchObject({ step: 1, playthrough: 1, completed: ["tutorial.started"] })
  await controller.guideAct("start")
  expect(starts).toBe(2)
  await store.dispose?.()
})


/*
 * R2-T2-1: ArrowRight is Next, Next is a gesture, and its refusal used to
 * reach the user as a toast titled "/onboarding.act didn't run". The reason
 * is the guide's own (controller/failures.ts routes it to guide.notice); the
 * flow id is never spoken.
 */
test("Next on an incomplete lesson refuses with the lesson's own reason", async () => {
  const { store, controller } = await setup(4, fetch)
  expect(await controller.guideAct("next")).toBe("Finish this step first.")
  expect(store.session().guide?.step).toBe(4)
  expect([...store.collections.toasts.values()]).toEqual([])
  await store.dispose?.()
})

/*
 * R2-T2-7: two Backs, then the beat's own pill again. The repeat resumes the
 * lesson's timer, which advanced one beat and — because that beat was walked
 * already — immediately bought a second, leaving the card the pill had just
 * reopened above the viewport.
 */
const walkedTo = async (store: Awaited<ReturnType<typeof setup>>["store"], step: number) => {
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step,
    completed: ["issues.opened", "issue.opened", "issue.flows.opened"] } }).isPersisted.promise
}

test("the repeated pill after two Backs advances exactly one beat and holds there", async () => {
  const { store, controller } = await setup(4, fetch)
  await walkedTo(store, 4)
  await controller.guideAct("back")
  await controller.guideAct("back")
  expect(store.session().guide?.step).toBe(2)
  // The pill's act repeats: onboarding/completion.ts lessonResumed restarts the timer.
  await store.dispatch({ type: "guide.changed", actor: "user",
    guide: { ...store.session().guide!, autoPaused: false } }).isPersisted.promise
  await controller.guideAct("advance", "0:2")
  expect(store.session().guide?.step).toBe(3)
  expect(store.session().guide?.autoPaused).toBe(true)
  await controller.guideAct("advance", "0:3")
  expect(store.session().guide?.step).toBe(3)
  await store.dispose?.()
})

test("Next over walked ground moves one beat per press", async () => {
  const { store, controller } = await setup(4, fetch)
  await walkedTo(store, 4)
  await controller.guideAct("back")
  await controller.guideAct("back")
  await controller.guideAct("next")
  await controller.guideAct("advance", "0:3")
  expect(store.session().guide?.step).toBe(3)
  expect(store.session().guide?.autoPaused).toBe(true)
  await store.dispose?.()
})


test("guide mount observations retain system attribution and ignore a closed controller", async () => {
  const { store } = await setup(2, fetch)
  const context = { store, commandActor: "smithers", disposed: false }
  const controller = createGuideController(context as unknown as ControllerContext)
  controller.observeGuideVisibility(true)
  expect(store.session().guideVisible).toBe(true)
  controller.observeGuideVisibility(false)
  const history = await store.eventHistory()
  expect(store.session().guideVisible).toBe(false)
  expect(history.events.filter(event => event.type === "guide.visibility.changed").map(event => event.actor)).toEqual(["system", "system"])
  context.disposed = true
  controller.observeGuideVisibility(true)
  expect((await store.eventHistory()).head).toEqual(history.head)
  expect(store.session().guideVisible).toBe(false)
  await store.dispose?.()
  expect(() => controller.observeGuideVisibility(false)).not.toThrow()
})
