import type { StorageApi } from "@tanstack/db"
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "../runtime/AgentPort"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { nameOf, parseSubmit } from "./registry"

/*
 * The code-intel flows (docs/code-intel/PLAN.md §4): `code.hover`,
 * `code.definition` and `code.diagnostics` are one act each with the three
 * doors, none user-only, none confirming (they read). Their door is the
 * language server plue runs inside the workspace VM, reached over the
 * `cloud.terminal` tunnel (state/CloudLspClient.ts), so BOTH hosts list them
 * wherever that tunnel is open and a host without it gets the origin refusal,
 * never a pointer at the native app.
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

/** The Bun server with the Smithers Cloud upstream configured: the tunnel is open. */
const NATIVE: AppBootstrap = {
  apiVersion: 1,
  host: "local",
  version: "test",
  buildSha: "test",
  capabilities: localCapabilities({ agent: true, identity: true, cloud: true }),
  authFlow: "both",
  sandbox: null
}

/** The Worker with the workspace terminal relay on. */
const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true }),
  authFlow: "redirect",
  sandbox: null
}

/** The same Worker with the relay off: the one door these flows need is shut. */
const WEB_WITHOUT_TUNNEL: AppBootstrap = {
  ...WEB,
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false })
}

const CODE_FLOWS = ["code.hover", "code.definition", "code.diagnostics"] as const

const controllerFor = async (bootstrap: AppBootstrap) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  return createAppController(store, unavailableRepositories, unavailableAgent, { bootstrap, socketUrl: () => undefined })
}

describe("the code.* flows", () => {
  for (const [label, bootstrap] of [["native", NATIVE], ["web", WEB]] as const) {
    test(`on the ${label} host with cloud.terminal the three flows are registered, listed with their grammars, and callable by the agent`, async () => {
      const controller = await controllerFor(bootstrap)
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
        expect(catalog.get(name)?.runtime).toEqual(["cloud.terminal"])
        expect(catalog.get(name)?.confirm).toBeUndefined()
        expect(catalog.get(name)?.hidden).not.toBe(true)
      }
    })
  }

  test("the slash door parses `/code.hover <path>:<line>:<col>` as the flow, not a prompt", async () => {
    const controller = await controllerFor(WEB)
    expect(parseSubmit("/code.hover src/x.ts:12:5", controller.commands.all())).toEqual({
      kind: "command",
      name: "code.hover",
      args: "src/x.ts:12:5"
    })
  })

  test("without the tunnel the flows are absent and the miss names the origin, never the native app", async () => {
    const controller = await controllerFor(WEB_WITHOUT_TUNNEL)
    for (const name of CODE_FLOWS) {
      expect(controller.commands.find(name)).toBeUndefined()
      expect(controller.commands.explainAbsent(name)).toEqual({
        door: "origin",
        reason: `/${name} is not available on this origin yet.`
      })
    }
  })
})
