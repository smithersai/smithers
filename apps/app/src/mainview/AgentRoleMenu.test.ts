import { roleMenuEntries } from "./AgentRoleMenu"
import { describe, expect, test } from "bun:test"
import type { Harness } from "@smthrs/rpc/LocalApp"

const harness = (overrides: Partial<Harness> & Pick<Harness, "id" | "status">): Harness => ({
  displayName: overrides.id,
  binary: overrides.status === "unavailable" ? null : `/usr/local/bin/${overrides.id}`,
  version: "1.0.0",
  account: null,
  launch: { argv: [overrides.id] },
  ...overrides
})

describe("the roles as the + menus list them", () => {
  test("a role is available exactly when its harness is installed with a credential; otherwise the reason names why", () => {
    const entries = roleMenuEntries([
      harness({ id: "claude", displayName: "Claude Code", status: "signed-in", account: { email: "will@example.com" } }),
      harness({ id: "codex", displayName: "Codex", status: "api-key", account: { label: "OPENAI_API_KEY" } }),
      harness({ id: "opencode-kimi", displayName: "OpenCode · Kimi", status: "binary-only" }),
      harness({ id: "opencode-cerebras", displayName: "OpenCode · Cerebras", status: "unavailable" })
    ])
    const byId = Object.fromEntries(entries.map((entry) => [entry.role.id, entry]))
    expect(entries.map((entry) => entry.role.id)).toEqual([
      "orchestrator",
      "explainer",
      "implementation",
      "trivial-implementation",
      "ui",
      "fast-ui"
    ])
    expect(byId.orchestrator).toMatchObject({ title: "Orchestrator · Fable 5", available: true, account: "will@example.com" })
    expect(byId.implementation).toMatchObject({ available: true, account: "OPENAI_API_KEY" })
    expect(byId["trivial-implementation"]).toMatchObject({ available: true })
    expect(byId.explainer).toMatchObject({ available: false, reason: "OpenCode · Kimi has no credential for Kimi K3" })
    expect(byId.ui).toMatchObject({ available: false })
    expect(byId["fast-ui"]).toMatchObject({ available: false, reason: "OpenCode · Cerebras is not installed" })
  })

  test("with no harness table at all every role is unavailable, named by its harness id", () => {
    for (const entry of roleMenuEntries([])) {
      expect(entry.available).toBe(false)
      expect(entry.reason).toBe(`${entry.role.harness} is not installed`)
    }
  })
})
