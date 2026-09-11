import { describe, expect, test } from "bun:test"
import { AGENT_ROLE_IDS, AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import type { Harness } from "@smthrs/rpc/LocalApp"
import { roleMenuEntries } from "./AgentRoleMenu"

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

  test("custom agents list after the built-ins under the same availability rule; an empty agents list is the built-ins", () => {
    const reviewer: AgentRole = {
      id: "reviewer",
      label: "Reviewer",
      purpose: "Reviews diffs.",
      model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      harness: "codex",
      delegates: false,
      builtin: false,
      createdAt: 5,
      updatedAt: 5
    }
    const docs: AgentRole = { ...reviewer, id: "docs-writer", label: "Docs writer", harness: "opencode-kimi", model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" }, createdAt: 9 }
    const harnesses = [
      harness({ id: "codex", displayName: "Codex", status: "api-key", account: { label: "OPENAI_API_KEY" } }),
      harness({ id: "opencode-kimi", displayName: "OpenCode · Kimi", status: "binary-only" })
    ]
    const entries = roleMenuEntries(harnesses, [docs, reviewer, ...AGENT_ROLES])
    expect(entries.map((entry) => entry.role.id)).toEqual([...AGENT_ROLE_IDS, "reviewer", "docs-writer"])
    const byId = Object.fromEntries(entries.map((entry) => [entry.role.id, entry]))
    expect(byId.reviewer).toMatchObject({ title: "Reviewer · GPT-5.6 Terra", available: true, account: "OPENAI_API_KEY" })
    expect(byId["docs-writer"]).toMatchObject({ available: false, reason: "OpenCode · Kimi has no credential for Kimi K3" })
    expect(roleMenuEntries(harnesses, []).map((entry) => entry.role.id)).toEqual([...AGENT_ROLE_IDS])
  })
})
