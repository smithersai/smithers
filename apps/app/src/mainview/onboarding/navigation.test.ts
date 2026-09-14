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

for (const step of [1, 3]) test(`Skip at ${step}, reload, then Back returns to the departure beat`, async () => {
  const completed = step === 1 ? [] : ["issues.opened", "issue.opened"]
  const { store, storage, controller } = await setup({ ...initialGuide(), step, completed })
  await controller.guideAct("skip-practice")
  expect(store.session().guide).toMatchObject({ step: 10, declined: ["practice"] })
  await store.dispose?.()
  const restored = await createAppStore({ kind: "localStorage", storage })
  const navigation = createGuideController({ store: restored, commandActor: "user" } as ControllerContext)
  await navigation.guideAct("back")
  expect(restored.session().guide?.step).toBe(step)
  expect(restored.session().guide?.completed).toEqual(completed)
  expect(restored.session().guide?.declined ?? []).not.toContain("practice")
  if (step === 3) {
    await navigation.guideAct("back")
    expect(restored.session().guide?.step).toBe(2)
    await navigation.guideAct("back")
  }
  await navigation.guideAct("back")
  expect(restored.session().guide?.step).toBe(1)
  await restored.dispose?.()
})

test("Skip remembers the exact departure even after rewinding completed beats", async () => {
  const { store, controller } = await setup({ ...initialGuide(), step: 4,
    completed: ["issues.opened", "issue.opened", "issue.flows.opened"] })
  await controller.guideAct("back")
  await controller.guideAct("back")
  await controller.guideAct("skip-practice")
  // The persisted schema must retain the departure, not infer it from the furthest completion.
  await store.dispatch({ type: "guide.changed", actor: "system", guide: GuideSchema.parse(store.session().guide) }).isPersisted.promise
  await controller.guideAct("back")
  expect(store.session().guide?.step).toBe(2)
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
