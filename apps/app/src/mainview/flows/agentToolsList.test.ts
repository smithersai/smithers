/*
 * The list action is the model's only discovery channel once the prompt
 * degrades to stage 3 (namespaces and counts only). Both tool loops bound every
 * tool result at MAX_TOOL_RESULT_BYTES, and the full registry rendered with
 * `acceptsArgs` + `args` measured 20 to 23 KiB: the model got a 16 KiB prefix
 * that did not parse and lost every search.*, repo.*, target.* name. This pins
 * the list against the REAL registry on both hosts, through the bound.
 */
import { describe, expect, test } from "bun:test"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { agentVisibleCatalog, executeAgentToolCall } from "./agentTools"
import { boundToolResult } from "../state/AgentTurnPolicy"
import { scopedControllers } from "../state/ControllerTestScope"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, settle, silentAgent } from "../state/TestFixtures"

const createAppController = scopedControllers()

const bootstraps: ReadonlyArray<AppBootstrap> = [
  {
    apiVersion: 1,
    host: "cloud",
    version: "test",
    buildSha: "cloud",
    capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true, browser: true }),
    authFlow: "redirect",
    sandbox: null
  },
  {
    apiVersion: 1,
    host: "local",
    version: "test",
    buildSha: "local",
    capabilities: localCapabilities({ agent: true, identity: true, cloud: true, browser: true }),
    authFlow: "native-handoff",
    sandbox: { platform: "darwin", mode: "enforced" }
  }
]

describe("the commands list action", () => {
  test.each([...bootstraps])("every callable command survives the tool-result bound on the $host host", async (bootstrap: AppBootstrap) => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, { bootstrap })
    store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null })
    await settle(2)
    const raw = await executeAgentToolCall(controller.commands, { name: "commands", arguments: JSON.stringify({ action: "list" }) })
    const bounded = boundToolResult(raw)
    expect(bounded.truncated).toBe(false)
    const parsed = JSON.parse(bounded.modelOutput) as { note?: string; commands: Array<{ name: string; summary?: string }> }
    const expected = agentVisibleCatalog(controller.commands.callable()).map((command) => command.name)
    expect(expected.length).toBeGreaterThan(100)
    expect(parsed.commands.map((command) => command.name)).toEqual(expected)
    /*
     * The ladder's contract, not one of its rungs: a command keeps its summary
     * unless the result SAYS the summaries went, and then it says how to get
     * them back. The cloud catalog crossed that threshold when `flow.plan`
     * stopped being a flagged door (D-080) — 200 commands render at 16279
     * bytes plus the note, against a 16384-byte bound — so the remedy below
     * is the half a model actually depends on there.
     */
    if (parsed.note === undefined) {
      for (const command of parsed.commands) expect(typeof command.summary).toBe("string")
    } else {
      expect(parsed.note).toContain("list one namespace")
    }
    // One namespace always carries its summaries and its args (the full list may have shed them to fit).
    const scoped = JSON.parse(
      await executeAgentToolCall(controller.commands, { name: "commands", arguments: JSON.stringify({ action: "list", namespace: "/repo" }) })
    ) as { note?: string; commands: Array<{ name: string; summary?: string; args?: string }> }
    expect(scoped.note).toBeUndefined()
    expect(scoped.commands.length).toBeGreaterThan(0)
    expect(scoped.commands.every((command) => command.name.startsWith("repo."))).toBe(true)
    expect(scoped.commands.map((command) => command.name)).toEqual(expected.filter((name) => name.startsWith("repo.")))
    expect(scoped.commands.some((command) => command.args !== undefined)).toBe(true)
    for (const command of scoped.commands) expect(typeof command.summary).toBe("string")
  })
})
