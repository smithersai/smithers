import { describe, expect, test } from "bun:test"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "./AppController"
import { createAppStore } from "./AppStore"
import { RECOVERY_DOWNLOAD_LABEL, RECOVERY_PRIVATE_WARNING } from "./StorageRecoveryContract"

const repositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({ status: "error", code: "native-required", message: "fixture unavailable" })
}
const agent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "fixture unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

describe("recovery through the real controller and registry", () => {
  test("the agent offers the human's embedded step; only the human receives the private file", async () => {
    const bytes = new Map<string, string>([["smithers-mvp-quarantine.fixture", "private retained original"]])
    const storage = {
      get length() {
        return bytes.size
      },
      key: (index: number) => [...bytes.keys()][index] ?? null,
      getItem: (key: string) => bytes.get(key) ?? null,
      setItem: (key: string, value: string) => {
        bytes.set(key, value)
      },
      removeItem: (key: string) => {
        bytes.delete(key)
      }
    }
    const store = await createAppStore({ kind: "localStorage", storage })
    const downloads: string[] = []
    let reads = 0
    const controller = createAppController(store, repositories, agent, {
      storageRecoveryHost: {
        read: async () => {
          reads++
          return store.readRecovery()
        },
        download: (json) => {
          downloads.push(json)
        }
      }
    })
    try {
      const offered = await controller.commands.runForAgent("storage.recovery")
      expect(offered.status).toBe("executed")
      const prompt = [...store.collections.messages.values()].find((message) =>
        message.action?.flow === "storage.recovery.export"
      )
      expect(prompt?.text).toBe(RECOVERY_PRIVATE_WARNING)
      expect(prompt?.action?.label).toBe(RECOVERY_DOWNLOAD_LABEL)
      const transition = [...store.collections.transitions.values()].find((entry) => entry.type === "message.appended")
      expect(transition?.actor).toBe("smithers")
      expect(store.session().surface).toBe("chat")
      const refused = await controller.commands.runForAgent("storage.recovery.export")
      expect(refused.status).toBe("failed")
      expect(JSON.stringify(refused)).toContain("storage.recovery")
      expect(reads).toBe(0)
      expect(downloads).toEqual([])
      const result = await controller.commands.run("storage.recovery.export")
      expect(result.status).toBe("executed")
      expect(reads).toBe(1)
      expect(downloads).toHaveLength(1)
      expect(JSON.parse(downloads[0]!).localStorage).toContainEqual({
        key: "smithers-mvp-quarantine.fixture",
        value: "private retained original"
      })
      expect(JSON.stringify(result)).not.toContain("private retained original")
      expect(JSON.stringify([...store.collections.messages.values()])).not.toContain("private retained original")
      expect(JSON.stringify([...store.collections.transitions.values()])).not.toContain("private retained original")
      expect(controller.storageRecoveryState.get("recovery")).toMatchObject({ phase: "ready", actor: "user" })
    } finally {
      await controller.dispose()
    }
  })
})
