import { describe, expect, it } from "bun:test"

import {
  factoryResetResultSchema,
  onboardingStatusSchema,
  settingsSchema,
  updateSettingsInputSchema,
} from "./settings"

describe("settings schema", () => {
  it("accepts the expanded settings payload", () => {
    expect(
      settingsSchema.parse({
        workspaceRoot: "/tmp/workspaces",
        defaultAgent: "Claude Code",
        smithersBaseUrl: "http://localhost:7331",
        allowNetwork: false,
        maxConcurrency: 4,
        maxBodyBytes: 1_048_576,
        smithersManagedPerWorkspace: true,
        smithersAuthMode: "bearer",
        hasSmithersAuthToken: true,
        rootDirPolicy: "workspace-root",
        diagnosticsLogLevel: "info",
        diagnosticsPrettyLogs: false,
      })
    ).toMatchObject({
      smithersAuthMode: "bearer",
      rootDirPolicy: "workspace-root",
      diagnosticsLogLevel: "info",
    })
  })

  it("accepts update payloads that preserve the current auth token", () => {
    expect(
      updateSettingsInputSchema.parse({
        workspaceRoot: "/tmp/workspaces",
        defaultAgent: "Codex",
        smithersBaseUrl: "https://smithers.example.com",
        allowNetwork: true,
        maxConcurrency: 6,
        maxBodyBytes: 2_097_152,
        smithersManagedPerWorkspace: false,
        smithersAuthMode: "x-smithers-key",
        rootDirPolicy: "process-default",
        diagnosticsLogLevel: "debug",
        diagnosticsPrettyLogs: true,
      })
    ).toMatchObject({
      clearSmithersAuthToken: false,
      smithersAuthMode: "x-smithers-key",
    })
  })

  it("tracks onboarding completion independently", () => {
    expect(onboardingStatusSchema.parse({ completed: true })).toEqual({ completed: true })
  })

  it("accepts factory reset results", () => {
    expect(factoryResetResultSchema.parse({ ok: true, deletedWorkspaceCount: 2 })).toEqual({
      ok: true,
      deletedWorkspaceCount: 2,
    })
  })
})
