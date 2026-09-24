import { describe, expect, test } from "bun:test"
import { scopedControllers } from "./ControllerTestScope"
import { createAppStore } from "./AppStore"
import { memoryStorage, unavailableAgent } from "./TestFixtures"

const createController = scopedControllers()

describe("chat filter flows", () => {
  test("all four flows dispatch actor-stamped durable state", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const controller = createController(store, unavailableAgent)
    expect((await controller.commands.run("chat.filter")).status).toBe("executed")
    expect(store.session().chatFilterMenuOpen).toBe(true)
    expect((await controller.commands.run("chat.filter.toggle", "chat")).status).toBe("executed")
    expect(store.session().chatFilter?.sources).toEqual(["chat"])
    expect((await controller.commands.run("chat.filter.grep", "error")).status).toBe("executed")
    expect(store.session().chatFilter?.query).toBe("error")
    expect((await controller.commands.run("chat.filter.grep")).status).toBe("executed")
    expect(store.session().chatFilter?.query).toBe("")
    await controller.commands.run("chat.filter.grep", "error")
    expect((await controller.commands.run("chat.filter.reset")).status).toBe("executed")
    expect(store.session().chatFilter).toEqual({ sources: [], kinds: [], query: "" })
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.session().chatFilter).toEqual({ sources: [], kinds: [], query: "" })
    expect(reopened.session().chatFilterMenuOpen).toBe(true)
    const filterTransitions = [...store.collections.transitions.values()].filter(row => row.type.startsWith("chat-filter.")).sort((a, b) => a.revision - b.revision)
    expect(filterTransitions.map(row => row.type)).toEqual([
      "chat-filter.menu.toggled", "chat-filter.changed", "chat-filter.changed", "chat-filter.changed", "chat-filter.changed", "chat-filter.changed"
    ])
    expect(filterTransitions.every(row => row.actor === "user")).toBe(true)
  })

  test("an active filter survives reload", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const controller = createController(store, unavailableAgent)
    await controller.commands.run("chat.filter.toggle", "chat")
    await controller.commands.run("chat.filter.grep", "error")
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(reopened.session().chatFilter).toEqual({ sources: ["chat"], kinds: [], query: "error" })
  })

  test("agent invocation records Smithers, unknown targets refuse, and missing target opens a form", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createController(store, unavailableAgent)
    expect((await controller.commands.runForAgent("chat.filter.toggle", "messages")).status).toBe("executed")
    expect([...store.collections.transitions.values()].find(row => row.type === "chat-filter.changed")?.actor).toBe("smithers")
    const unknown = await controller.commands.run("chat.filter.toggle", "unknown")
    expect(unknown.status).toBe("failed")
    expect(JSON.stringify(unknown)).toContain("chat")
    expect(JSON.stringify(unknown)).toContain("messages")
    expect(await controller.commands.run("chat.filter.toggle")).toMatchObject({ status: "form", fields: ["target"] })
  })
})
