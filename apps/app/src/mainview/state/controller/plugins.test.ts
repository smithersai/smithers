import { expect, test } from "bun:test"
import { LESSON_PLUGIN, LIBRARIAN_LESSON_STEP, PLUGINS_LESSON_STEP } from "../../onboarding/pluginLesson"
import { createAppStore } from "../AppStore"
import { initialGuide } from "../AppState"
import { createPluginsController } from "./plugins"
import type { ControllerContext } from "./context"

const setup = async (guideStep?: number) => {
  const data = new Map<string, string>()
  const store = await createAppStore({
    kind: "localStorage",
    storage: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value) },
      removeItem: (key) => { data.delete(key) }
    }
  })
  if (guideStep !== undefined) {
    await store.dispatch({
      type: "guide.changed",
      actor: "user",
      guide: { ...initialGuide(), step: guideStep, library: guideStep > PLUGINS_LESSON_STEP }
    }).isPersisted.promise
  }
  const controller = createPluginsController({ store, commandActor: "user" } as unknown as ControllerContext)
  return { store, controller }
}

test("installing writes the shelf once, and says so the second time", async () => {
  const { store, controller } = await setup()
  expect(controller.installPlugin("dispatcher")).toBeUndefined()
  expect(store.session().plugins).toEqual(["dispatcher"])
  expect(controller.installPlugin("dispatcher")).toContain("already installed")
  expect(store.session().plugins).toEqual(["dispatcher"])
  await store.dispose?.()
})

test("a plugin's dependency is installed with it, ahead of it", async () => {
  const { store, controller } = await setup()
  controller.installPlugin("factory")
  expect(store.session().plugins).toEqual(["librarian", "factory"])
  await store.dispose?.()
})

test("a plugin something else depends on is kept until the dependent goes", async () => {
  const { store, controller } = await setup()
  controller.installPlugin("factory")
  expect(controller.removePlugin("librarian")).toContain("Remove Factory first")
  expect(controller.removePlugin("factory")).toBeUndefined()
  expect(controller.removePlugin("librarian")).toBeUndefined()
  expect(store.session().plugins).toEqual([])
  await store.dispose?.()
})

test("a plugin the catalog has never heard of is refused, both ways", async () => {
  const { controller, store } = await setup()
  expect(controller.installPlugin("nonesuch")).toContain("No plugin named")
  expect(controller.removePlugin("nonesuch")).toContain("No plugin named")
  expect(controller.removePlugin("box")).toContain("not installed")
  await store.dispose?.()
})

test("the shelf answers the model with what is installed and what is recommended", async () => {
  const { controller, store } = await setup()
  controller.installPlugin("box")
  const answer = controller.listPlugins().value
  expect(answer).toContain("librarian — Librarian (recommended #1)")
  expect(answer).toContain("box — Box (installed)")
  await store.dispose?.()
})

test("the Library pane toggles, and back to the conversation", async () => {
  const { store, controller } = await setup()
  controller.showPlugins()
  expect(store.session().surface).toBe("plugins")
  controller.showPlugins()
  expect(store.session().surface).toBe("chat")
  await store.dispose?.()
})

test("during its lesson, opening the Library and installing the plugin advance the guide", async () => {
  const { store, controller } = await setup(PLUGINS_LESSON_STEP)
  controller.showPlugins()
  expect(store.session().guide?.library).toBe(true)
  expect(store.session().guide?.step).toBe(PLUGINS_LESSON_STEP)
  expect(store.session().guide?.completed).toContain("library")
  await store.dispatch({ type: "guide.changed", actor: "system", guide: { ...store.session().guide!, step: LIBRARIAN_LESSON_STEP } }).isPersisted.promise
  controller.installPlugin(LESSON_PLUGIN)
  expect(store.session().plugins).toEqual([LESSON_PLUGIN])
  expect(store.session().guide?.librarian).toBe(true)
  expect(store.session().guide?.step).toBe(LIBRARIAN_LESSON_STEP)
  expect(store.session().guide?.completed).toContain("librarian")
  await store.dispose?.()
})

test("outside the lesson the same flows leave the guide alone", async () => {
  const { store, controller } = await setup(0)
  controller.showPlugins()
  controller.installPlugin(LESSON_PLUGIN)
  expect(store.session().guide?.step).toBe(0)
  expect(store.session().guide?.librarian).toBe(false)
  await store.dispose?.()
})
