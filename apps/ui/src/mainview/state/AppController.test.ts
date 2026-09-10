import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

/** Mirrors a web-mode agent whose server boundary is unreachable: every turn errors. */
const webAgent = (message = "Could not reach the Smithers web agent."): AgentPort => ({
  available: false,
  startTurn: async () => ({ status: "error", message }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createAppController in pure web mode", () => {
  test("reports the native agent as unavailable without blocking the composer path", async () => {
    const controller = createAppController(await webStore(), unavailableRepositories, webAgent())
    expect(controller.nativeAgentAvailable).toBe(false)
    expect(controller.nativeRepositoriesAvailable).toBe(false)
  })

  test("records the user message and a visible failure when no native agent can run the turn", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, webAgent())

    controller.send("hello from the web build")
    await settled()

    const messages = [...store.collections.messages.values()]
    const submitted = messages.find((message) => message.text === "hello from the web build")
    expect(submitted?.role).toBe("user")

    const failure = messages.find((message) => message.status === "failed")
    expect(failure?.role).toBe("smithers")
    expect(failure?.text).toContain("Could not reach the Smithers web agent.")
  })

  test("returns the session to idle so the composer stays usable after a failed turn", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, webAgent())

    controller.send("first attempt")
    await settled()
    expect(store.session().phase).toBe("idle")

    controller.send("second attempt")
    await settled()
    const texts = [...store.collections.messages.values()].map((message) => message.text)
    expect(texts).toContain("second attempt")
  })

  test("renders a streamed web turn to completion through the shared frame contract", async () => {
    const store = await webStore()
    const listeners = new Set<(frame: AgentTurnFrame) => void>()
    const streamingAgent: AgentPort = {
      available: true,
      startTurn: async (request) => {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({ runId: request.runId, type: "delta", kind: "text", text: "Hello from " })
            listener({ runId: request.runId, type: "delta", kind: "text", text: "Smithers Cloud." })
            listener({ runId: request.runId, type: "done" })
          }
        })
        return { status: "started" }
      },
      cancelTurn: async () => {},
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    const controller = createAppController(store, unavailableRepositories, streamingAgent)
    expect(controller.nativeAgentAvailable).toBe(true)

    controller.send("Hello who are you")
    await settled()

    const response = [...store.collections.messages.values()]
      .filter((message) => message.role === "smithers")
      .sort((left, right) => right.ordinal - left.ordinal)[0]
    expect(response?.text).toBe("Hello from Smithers Cloud.")
    expect(response?.status).toBe("complete")
    expect(store.session().phase).toBe("idle")
  })

  test("journals composer and theme transitions with their actor in web mode", async () => {
    const store = await webStore()
    const controller = createAppController(store, unavailableRepositories, webAgent())

    controller.changeDraft("draft in the browser")
    expect(store.session().draft).toBe("draft in the browser")

    const before = store.session().theme
    controller.toggleTheme()
    expect(store.session().theme).not.toBe(before)

    const journal = [...store.collections.transitions.values()]
    expect(journal.some((record) => record.type === "theme.changed" && record.actor === "user")).toBe(true)
  })
})

describe("the controller's command surface", () => {
  test("runCommand takes optional args in one member, with the split members gone", async () => {
    const controller = createAppController(await webStore(), unavailableRepositories, webAgent())

    expect(controller.runCommand("definitely-not-a-command")).toBe(false)
    expect(controller.runCommand("definitely-not-a-command", "with args")).toBe(false)
    expect(controller.commands.find("palette.open")).toBeDefined()
    expect(controller.runCommand("palette.open")).toBe(true)
    expect(controller.runCommand("palette.open", "ignored args")).toBe(true)

    expect("runCommandArgs" in controller).toBe(false)
    expect("withAgentActor" in controller).toBe(false)
    // The registry's state read stays internal to it.
    expect("snapshot" in controller).toBe(false)
  })

  /*
   * ui-state-store/maintainability/1: the returned controller must BE the
   * command registry's action map plus the composition root's own members —
   * one spread, so every controller key is the same function reference the
   * registry bound. A hand-wired member in the return block can drift from
   * the registry's binding; fail on any member that is not the spread or a
   * named composition-root extra.
   */
  test("every controller key is the registry binding by construction (one spread, no re-enumeration)", () => {
    const source = readFileSync(fileURLToPath(new URL("./AppController.ts", import.meta.url)), "utf8")
    expect(source).toContain("const { snapshot: _snapshot, ...sharedActions } = commandActions")
    expect(source).not.toContain("withAgentActor")
    expect(source).not.toContain("runCommandArgs")

    const returned = source.slice(source.indexOf("...sharedActions"))
    const block = returned.slice(0, returned.indexOf("\n  }\n}"))
    const members = block.split("\n")
      .map((line) => /^\s{4}(?:readonly )?([A-Za-z_$][\w$]*)\b/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined)
    const compositionRoot = [
      "store",
      "storageRecoveryState",
      "downloadUrl",
      "features",
      "nativeAgentAvailable",
      "nativeRepositoriesAvailable",
      "tappedFetch",
      "commands",
      "slashItems",
      "slashTree",
      "runCommand",
      "dispose"
    ]
    expect(members.sort()).toEqual([...compositionRoot].sort())
  })
})
