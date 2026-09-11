import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { nameOf, parseSubmit } from "./registry"

/*
 * The code-intel flows (docs/code-intel/PLAN.md §4): `code.hover`,
 * `code.definition` and `code.diagnostics` are one act each with the three
 * doors, none user-only, none confirming (they read). Their door is the
 * native host's language server (`local.lsp`), so the web catalog never
 * lists them and a miss there names the native app.
 */

const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

const unavailableAgent: AgentPort = {
  available: false,
  startTurn: async () => ({ status: "error", message: "unavailable" }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
}

const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repositories can only be connected from the Smithers native app."
  })
}

const NATIVE: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: ["agent", "identity", "local.repositories", "local.lsp"],
  authFlow: "both",
  sandbox: null
}

const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true }),
  authFlow: "redirect",
  sandbox: null
}

const CODE_FLOWS = ["code.hover", "code.definition", "code.diagnostics"] as const

const controllerFor = async (bootstrap: AppBootstrap) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return createAppController(store, unavailableRepositories, unavailableAgent, { bootstrap, socketUrl: () => undefined })
}

describe("the code.* flows", () => {
  test("on the native host with local.lsp the three flows are registered, listed with their grammars, and callable by the agent", async () => {
    const controller = await controllerFor(NATIVE)
    const callable = new Set(controller.commands.callable().map(nameOf))
    const disclosed = new Map(controller.commands.disclosed().map((descriptor) => [descriptor.name, descriptor]))
    for (const name of CODE_FLOWS) {
      expect(callable.has(name)).toBe(true)
      expect(disclosed.has(name)).toBe(true)
    }
    const catalog = new Map(controller.commands.all().map((item) => [item.name, item]))
    expect(catalog.get("code.hover")?.args).toBe("<path>:<line>:<col> [owner/repo]")
    expect(catalog.get("code.definition")?.args).toBe("<path>:<line>:<col> [owner/repo]")
    expect(catalog.get("code.diagnostics")?.args).toBe("<path> [owner/repo]")
    for (const name of CODE_FLOWS) {
      expect(catalog.get(name)?.runtime).toEqual(["local.lsp"])
      expect(catalog.get(name)?.confirm).toBeUndefined()
      expect(catalog.get(name)?.hidden).not.toBe(true)
    }
  })

  test("the slash door parses `/code.hover <path>:<line>:<col>` as the flow, not a prompt", async () => {
    const controller = await controllerFor(NATIVE)
    expect(parseSubmit("/code.hover src/x.ts:12:5", controller.commands.all())).toEqual({
      kind: "command",
      name: "code.hover",
      args: "src/x.ts:12:5"
    })
  })

  test("on the web the flows are absent and the miss names the native app", async () => {
    const controller = await controllerFor(WEB)
    for (const name of CODE_FLOWS) {
      expect(controller.commands.find(name)).toBeUndefined()
      expect(controller.commands.explainAbsent(name)).toEqual({
        door: "local",
        reason: `/${name} is not in the web app — it needs the native app.`
      })
    }
  })
})
