import { expect, test } from "bun:test"
import { createAppStore } from "../state/AppStore"
import { initialGuide } from "../state/AppState"
import { createGuideController } from "../state/controller/guide"
import type { ControllerContext } from "../state/controller/context"
import { REEL_STAGES } from "./reel.ts"

test("Finish persists across reload and only explicit restart clears it", async () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 14 } }).isPersisted.promise
  const controller = createGuideController({ store, commandActor: "user" } as unknown as ControllerContext)
  await controller.guideAct("finish")
  expect(store.session().guide?.finished).toBe(true)
  await store.dispose?.()
  const reloaded = await createAppStore({ kind: "localStorage", storage })
  expect(reloaded.session().guide?.finished).toBe(true)
  const resumed = createGuideController({ store: reloaded, commandActor: "user" } as unknown as ControllerContext)
  await resumed.guideAct("restart")
  expect(reloaded.session().guide?.finished).not.toBe(true)
  expect(reloaded.session().guide?.step).toBe(1)
  await reloaded.dispose?.()
})

test("final reel Next marks the tutorial finished and clears borrowed UI", async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 14, reelIndex: REEL_STAGES.length - 1, reelEpoch: 1, conversationOpen: true } }).isPersisted.promise
  const controller = createGuideController({ store, commandActor: "user" } as unknown as ControllerContext)
  await controller.guideAct("reel-next", `1:${REEL_STAGES.length - 1}`)
  expect(store.session().guide?.finished).toBe(true)
  expect(store.session().guide?.reelIndex).toBeUndefined()
  expect(store.session().guide?.conversationOpen).toBe(false)
  await store.dispose?.()
})
