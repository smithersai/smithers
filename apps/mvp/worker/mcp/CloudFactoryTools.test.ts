import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  CLOUD_FACTORY_TOOL_DESCRIPTORS,
  CLOUD_FACTORY_TOOL_NAMES,
  isCloudFactoryTool,
  visibleDescriptors,
} from "./CloudFactoryTools.vibe"
import type { McpPrincipal } from "./Contract.vibe"

const readOnlyPrincipal: McpPrincipal = {
  tokenId: "tok-read",
  personId: "p-1",
  login: "alice",
  clientName: "Claude Code",
  repoScope: null,
  scopes: ["mcp:read"],
  actor: { subject: { kind: "person", id: "p-1" }, role: null, login: "alice", act: { kind: "agent", id: "mcp:tok-read" } },
}

const readWritePrincipal: McpPrincipal = {
  ...readOnlyPrincipal,
  tokenId: "tok-rw",
  scopes: ["mcp:read", "mcp:write"],
}

describe("CloudFactoryTools catalog and visibility", () => {
  it("registers all 15 cloud factory MCP tools covering artifacts, changesets, wiki, mythical history, audit reports, and one-time auth", () => {
    expect(CLOUD_FACTORY_TOOL_NAMES.length).toBe(15)
    expect(CLOUD_FACTORY_TOOL_DESCRIPTORS.length).toBe(15)
    for (const name of CLOUD_FACTORY_TOOL_NAMES) {
      expect(isCloudFactoryTool(name)).toBe(true)
    }
    expect(isCloudFactoryTool("pull_merge")).toBe(false)
    expect(isCloudFactoryTool("unknown_tool")).toBe(false)
  })

  it("exposes read-only tools publicly and gates write tools behind mcp:write", () => {
    const anonTools = visibleDescriptors(Option.none()).map((t) => t.name)
    expect(anonTools).toEqual([
      "artifact_list",
      "artifact_get",
      "changeset_stack_list",
      "wiki_list",
      "wiki_read",
      "mythical_history_list",
      "audit_report_list",
      "audit_report_get",
    ])

    const readTools = visibleDescriptors(Option.some(readOnlyPrincipal)).map((t) => t.name)
    expect(readTools).toEqual(anonTools)

    const rwTools = visibleDescriptors(Option.some(readWritePrincipal)).map((t) => t.name)
    expect(rwTools).toContain("artifact_put")
    expect(rwTools).toContain("changeset_create")
    expect(rwTools).toContain("wiki_write")
    expect(rwTools).toContain("mythical_history_record")
    expect(rwTools).toContain("audit_report_publish")
    expect(rwTools).toContain("auth_one_time_mint")
    expect(rwTools).toContain("pull_create")
    expect(rwTools.length).toBe(15)
  })
})
