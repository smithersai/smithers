import { expect, test } from "bun:test"
import { createAppStore } from "../state/AppStore"
import { initialGuide } from "../state/AppState"
import { createGuideController } from "../state/controller/guide"
import type { ControllerContext } from "../state/controller/context"
import { REEL_STAGES } from "./reel.ts"
import { ENVELOPE_STORAGE_KEY } from "../chain/TransactionalStorage"

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


for (const finish of ["finish", "reel-next"]) test(`${finish} clears tutorial notifications and prepares the destination before finishing`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  await store.dispatch({ type: "guide.changed", actor: "user", guide: { ...initialGuide(), step: 14,
    ...(finish === "reel-next" ? { reelIndex: REEL_STAGES.length - 1, reelEpoch: 1 } : {}) } }).isPersisted.promise
  for (const key of ["reel-notify-test", "reel-wait-test", "guide-hello-test", "real-wiki"]) {
    store.dispatch({ type: "toast.shown", actor: "system", key, title: key })
  }
  const destinations: string[] = []
  const controller = createGuideController({ store, commandActor: "user" } as unknown as ControllerContext, undefined, async repo => {
    expect(store.session().guide?.finished).not.toBe(true)
    destinations.push(repo)
  })
  await controller.guideAct(finish, `1:${REEL_STAGES.length - 1}`)
  expect(destinations).toEqual(["smithersai/smithers"])
  expect(store.session().guide?.finished).toBe(true)
  expect([...store.collections.toasts.values()].map(toast => toast.key)).toEqual(["real-wiki"])
  await store.dispose?.()
})

test("Finish acknowledges the handoff only after its completion is durable", async () => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: key => { data.delete(key) },
  } })
  let acknowledged = false
  const controller = createGuideController({ store, commandActor: "user" } as unknown as ControllerContext,
    undefined, undefined, () => {
      const envelope = JSON.parse(data.get(ENVELOPE_STORAGE_KEY)!)
      const saved = JSON.parse(envelope.entries["smithers-mvp.app-sessions"])
      expect(saved["s:main"].data.guide.finished).toBe(true)
      acknowledged = true
    })
  await controller.guideAct("finish")
  expect(acknowledged).toBe(true)
  await store.dispose?.()
})
