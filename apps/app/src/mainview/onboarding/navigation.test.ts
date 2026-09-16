import { expect, test } from "bun:test"
import { createAppStore } from "../state/AppStore"
import { GuideSchema, initialGuide, type GuideState } from "../state/AppState"
import { memoryStorage } from "../state/TestFixtures"
import { createGuideController } from "../state/controller/guide"
import type { ControllerContext } from "../state/controller/context"

async function setup(guide: GuideState) {
  const storage = memoryStorage()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "guide.changed", actor: "user", guide }).isPersisted.promise
  const controller = createGuideController({ store, commandActor: "user" } as ControllerContext)
  return { store, storage, controller }
}

for (const step of [1, 3]) test(`Skip at ${step} stays finished after reload`, async () => {
  const completed = step === 1 ? [] : ["issues.opened", "issue.opened"]
  const { store, storage, controller } = await setup({ ...initialGuide(), step, completed })
  await controller.guideAct("skip")
  expect(store.session().guide).toMatchObject({ step: 14, finished: true, declined: ["practice"], practiceSkippedFrom: step })
  await store.dispose?.()
  const restored = await createAppStore({ kind: "localStorage", storage })
  expect(restored.session().guide).toMatchObject({ step: 14, finished: true, completed, practiceSkippedFrom: step })
  await restored.dispose?.()
})

test("Skip remembers the exact departure after rewinding completed beats", async () => {
  const { store, controller } = await setup({ ...initialGuide(), step: 4,
    completed: ["issues.opened", "issue.opened", "issue.flows.opened"] })
  await controller.guideAct("back")
  await controller.guideAct("back")
  await controller.guideAct("skip")
  expect(GuideSchema.parse(store.session().guide)).toMatchObject({ step: 14, finished: true, practiceSkippedFrom: 2 })
  await store.dispose?.()
})

test("old skipped guides recover the reached beat, and Back skips missing completion receipts", async () => {
  const { store, controller } = await setup({ ...initialGuide(), step: 10,
    declined: ["practice"], completed: ["issues.opened", "issue.opened"] })
  await controller.guideAct("back")
  expect(store.session().guide?.step).toBe(3)
  await store.dispatch({ type: "guide.changed", actor: "system", guide: {
    ...initialGuide(), step: 8, completed: ["issues.opened", "plan.ready"],
  } }).isPersisted.promise
  await controller.guideAct("back")
  expect(store.session().guide?.step).toBe(5)
  await store.dispose?.()
})

test("Back at stage 1 leaves the guide unchanged", async () => {
  const guide = initialGuide()
  const { store, controller } = await setup(guide)
  await controller.guideAct("back")
  expect(store.session().guide).toEqual(guide)
  await store.dispose?.()
})

for (const refusal of [undefined, "Repository unavailable"]) test(`Skip shares finish cleanup and refusal handling: ${refusal ?? "accepted"}`, async () => {
  const original = { ...initialGuide(), step: 3, conversationOpen: true, notice: "Pending", noticeDetail: "Details" }
  const { store } = await setup(original)
  await store.dispatch({ type: "toast.shown", actor: "system", key: "guide-tip-skip", title: "Tip" }).isPersisted.promise
  const repos: string[] = []
  let finished = 0
  const controller = createGuideController({ store, commandActor: "user" } as ControllerContext, undefined,
    async repo => { repos.push(repo); return refusal }, () => { finished++ })
  expect(await controller.guideAct("skip")).toBe(refusal)
  expect(repos).toEqual(["smithersai/smithers"])
  expect(finished).toBe(refusal ? 0 : 1)
  if (refusal) expect(store.session().guide).toEqual(original)
  else {
    expect(store.session().guide).toMatchObject({ finished: true, step: 14, conversationOpen: false })
    expect(store.session().guide?.notice).toBeUndefined()
    expect(store.session().guide?.noticeDetail).toBeUndefined()
    expect([...store.collections.toasts.values()].some(toast => toast.key === "guide-tip-skip")).toBe(false)
  }
  await store.dispose?.()
})
