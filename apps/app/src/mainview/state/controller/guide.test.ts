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
