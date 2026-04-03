import { describe, expect, it } from "bun:test"

import { canEditWorkspaceWorkflows } from "./access"

describe("workflow access helpers", () => {
  it("allows workflow editing for Burns-managed workspaces", () => {
    expect(canEditWorkspaceWorkflows({ runtimeMode: "burns-managed" })).toBe(true)
  })

  it("blocks workflow editing for self-managed workspaces", () => {
    expect(canEditWorkspaceWorkflows({ runtimeMode: "self-managed" })).toBe(false)
  })

  it("defaults to editable when workspace data is still loading", () => {
    expect(canEditWorkspaceWorkflows(undefined)).toBe(true)
  })
})
