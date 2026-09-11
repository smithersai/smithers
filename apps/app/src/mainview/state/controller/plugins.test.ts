import { expect, test } from "bun:test"
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
      guide: { ...initialGuide(), step: guideStep, library: false }
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
