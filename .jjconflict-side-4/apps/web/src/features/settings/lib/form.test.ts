import { describe, expect, it } from "bun:test"

import {
  buildDefaultAgentOptions,
  buildUpdateSettingsInput,
  settingsToFormValues,
  shouldShowOnboarding,
  validateSettingsForm,
} from "./form"

describe("settings form helpers", () => {
  it("maps settings into editable form state", () => {
    expect(
      settingsToFormValues({
        workspaceRoot: "/tmp/workspaces",
        defaultAgent: "Claude Code",
        smithersBaseUrl: "http://localhost:7331",
        allowNetwork: false,
        maxConcurrency: 4,
        maxBodyBytes: 1048576,
        smithersManagedPerWorkspace: true,
        smithersAuthMode: "bearer",
        hasSmithersAuthToken: true,
        rootDirPolicy: "workspace-root",
        diagnosticsLogLevel: "info",
        diagnosticsPrettyLogs: false,
      })
    ).toEqual({
      workspaceRoot: "/tmp/workspaces",
      defaultAgent: "Claude Code",
      smithersBaseUrl: "http://localhost:7331",
      allowNetwork: "false",
      maxConcurrency: "4",
      maxBodyBytes: "1048576",
      smithersManagedPerWorkspace: "true",
      smithersAuthMode: "bearer",
      smithersAuthToken: "",
      rootDirPolicy: "workspace-root",
      diagnosticsLogLevel: "info",
      diagnosticsPrettyLogs: "false",
    })
  })

  it("builds update payloads with boolean conversions", () => {
    expect(
      buildUpdateSettingsInput({
        workspaceRoot: "/tmp/workspaces",
        defaultAgent: "Codex",
        smithersBaseUrl: "https://smithers.example.com",
        allowNetwork: "true",
        maxConcurrency: "6",
        maxBodyBytes: "2097152",
        smithersManagedPerWorkspace: "false",
        smithersAuthMode: "x-smithers-key",
        smithersAuthToken: " token ",
        rootDirPolicy: "process-default",
        diagnosticsLogLevel: "debug",
        diagnosticsPrettyLogs: "true",
      })
    ).toEqual({
      workspaceRoot: "/tmp/workspaces",
      defaultAgent: "Codex",
      smithersBaseUrl: "https://smithers.example.com",
      allowNetwork: true,
      maxConcurrency: 6,
      maxBodyBytes: 2097152,
      smithersManagedPerWorkspace: false,
      smithersAuthMode: "x-smithers-key",
      smithersAuthToken: "token",
      clearSmithersAuthToken: false,
      rootDirPolicy: "process-default",
      diagnosticsLogLevel: "debug",
      diagnosticsPrettyLogs: true,
    })
  })

  it("validates required fields", () => {
    expect(
      validateSettingsForm({
        workspaceRoot: "relative/path",
        defaultAgent: "",
        smithersBaseUrl: "notaurl",
        allowNetwork: "false",
        maxConcurrency: "0",
        maxBodyBytes: "abc",
        smithersManagedPerWorkspace: "true",
        smithersAuthMode: "bearer",
        smithersAuthToken: "",
        rootDirPolicy: "workspace-root",
        diagnosticsLogLevel: "info",
        diagnosticsPrettyLogs: "false",
      })
    ).toEqual({
      workspaceRoot: "Workspace root must be an absolute path.",
      defaultAgent: "Default agent is required.",
      smithersBaseUrl: "Smithers URL must be a valid absolute URL.",
      maxConcurrency: "Max concurrency must be a positive integer.",
      maxBodyBytes: "Max body bytes must be a positive integer.",
    })
  })

  it("shows onboarding only when there are no workspaces and onboarding is incomplete", () => {
    expect(shouldShowOnboarding({ workspacesCount: 0, onboardingCompleted: false })).toBe(true)
    expect(shouldShowOnboarding({ workspacesCount: 1, onboardingCompleted: false })).toBe(false)
    expect(shouldShowOnboarding({ workspacesCount: 0, onboardingCompleted: true })).toBe(false)
  })

  it("includes the current default agent when it is not installed", () => {
    expect(buildDefaultAgentOptions([{ name: "Codex" }], "Claude Code")).toEqual([
      { value: "Claude Code", label: "Claude Code (current)" },
      { value: "Codex", label: "Codex" },
    ])
  })
})
