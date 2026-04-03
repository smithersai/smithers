import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"

import { afterEach, describe, expect, it } from "bun:test"

import { insertWorkspaceRow } from "@/db/repositories/workspace-repository"
import { createApp } from "@/server/app"
import { clearSettingsForTests, factoryResetAppState } from "@/services/settings-service"
import { resolveTestWorkspacePath } from "@/testing/test-workspace-path"

const workspacePathsToDelete = new Set<string>()

afterEach(async () => {
  await factoryResetAppState()
  clearSettingsForTests()
  for (const workspacePath of workspacePathsToDelete) {
    rmSync(workspacePath, { recursive: true, force: true })
  }
  workspacePathsToDelete.clear()
})

function seedWorkspace() {
  const workspaceId = `test-workspace-${randomUUID()}`
  const workspacePath = resolveTestWorkspacePath(workspaceId)
  mkdirSync(workspacePath, { recursive: true })
  const now = new Date().toISOString()

  insertWorkspaceRow({
    id: workspaceId,
    name: workspaceId,
    path: workspacePath,
    sourceType: "create",
    runtimeMode: "burns-managed",
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
  })

  workspacePathsToDelete.add(workspacePath)
  return { workspaceId, workspacePath }
}

describe("settings routes", () => {
  it("updates settings and hides the auth token in responses", async () => {
    const app = createApp()

    const updateResponse = await app.fetch(
      new Request("http://localhost:7332/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceRoot: "/tmp/burns-workspaces",
          defaultAgent: "Codex",
          smithersBaseUrl: "https://smithers.example.com",
          allowNetwork: true,
          maxConcurrency: 6,
          maxBodyBytes: 2097152,
          smithersManagedPerWorkspace: true,
          smithersAuthMode: "x-smithers-key",
          smithersAuthToken: "secret-token",
          rootDirPolicy: "process-default",
          diagnosticsLogLevel: "debug",
          diagnosticsPrettyLogs: true,
        }),
      })
    )

    expect(updateResponse.status).toBe(200)
    expect(await updateResponse.json()).toMatchObject({
      settings: {
        workspaceRoot: "/tmp/burns-workspaces",
        defaultAgent: "Codex",
        smithersBaseUrl: "https://smithers.example.com",
        allowNetwork: true,
        maxConcurrency: 6,
        maxBodyBytes: 2097152,
        smithersManagedPerWorkspace: true,
        smithersAuthMode: "x-smithers-key",
        hasSmithersAuthToken: true,
        rootDirPolicy: "process-default",
        diagnosticsLogLevel: "debug",
        diagnosticsPrettyLogs: true,
      },
      reconcileSummary: {
        managedRuntimeSettingsChanged: true,
      },
    })

    const getResponse = await app.fetch(new Request("http://localhost:7332/api/settings"))
    expect(getResponse.status).toBe(200)
    const settingsPayload = (await getResponse.json()) as Record<string, unknown>
    expect(settingsPayload.hasSmithersAuthToken).toBe(true)
    expect(settingsPayload.smithersAuthToken).toBeUndefined()
  })

  it("resets settings without clearing onboarding completion", async () => {
    const app = createApp()

    await app.fetch(
      new Request("http://localhost:7332/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceRoot: "/tmp/custom-root",
          defaultAgent: "Codex",
          smithersBaseUrl: "https://smithers.example.com",
          allowNetwork: true,
          maxConcurrency: 8,
          maxBodyBytes: 3145728,
          smithersManagedPerWorkspace: true,
          smithersAuthMode: "bearer",
          smithersAuthToken: "secret-token",
          rootDirPolicy: "process-default",
          diagnosticsLogLevel: "debug",
          diagnosticsPrettyLogs: true,
        }),
      })
    )

    await app.fetch(new Request("http://localhost:7332/api/onboarding-status/complete", { method: "POST" }))

    const resetResponse = await app.fetch(
      new Request("http://localhost:7332/api/settings/reset", { method: "POST" })
    )
    expect(resetResponse.status).toBe(200)
    const resetPayload = (await resetResponse.json()) as Record<string, unknown>
    expect(resetPayload).toMatchObject({
      settings: {
        hasSmithersAuthToken: false,
        allowNetwork: false,
        maxConcurrency: 4,
        maxBodyBytes: 1048576,
        rootDirPolicy: "workspace-root",
      },
      reconcileSummary: {
        managedRuntimeSettingsChanged: true,
      },
    })

    const onboardingResponse = await app.fetch(
      new Request("http://localhost:7332/api/onboarding-status")
    )
    expect(onboardingResponse.status).toBe(200)
    expect(await onboardingResponse.json()).toEqual({ completed: true })
  })

  it("validates update payloads", async () => {
    const app = createApp()

    const response = await app.fetch(
      new Request("http://localhost:7332/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceRoot: "",
          defaultAgent: "",
          smithersBaseUrl: "notaurl",
          allowNetwork: false,
          maxConcurrency: 0,
          maxBodyBytes: 0,
          smithersManagedPerWorkspace: false,
          smithersAuthMode: "bearer",
          rootDirPolicy: "workspace-root",
          diagnosticsLogLevel: "info",
          diagnosticsPrettyLogs: false,
        }),
      })
    )

    expect(response.status).toBe(400)
  })

  it("tracks onboarding completion independently from workspace creation", async () => {
    const app = createApp()

    const initialResponse = await app.fetch(new Request("http://localhost:7332/api/onboarding-status"))
    expect(initialResponse.status).toBe(200)
    expect(await initialResponse.json()).toEqual({ completed: false })

    const completeResponse = await app.fetch(
      new Request("http://localhost:7332/api/onboarding-status/complete", { method: "POST" })
    )
    expect(completeResponse.status).toBe(200)
    expect(await completeResponse.json()).toEqual({ completed: true })
  })

  it("factory resets Burns state without deleting workspace repo folders", async () => {
    const app = createApp()
    const { workspaceId, workspacePath } = seedWorkspace()

    await app.fetch(
      new Request("http://localhost:7332/api/onboarding-status/complete", { method: "POST" })
    )

    const response = await app.fetch(
      new Request("http://localhost:7332/api/settings/factory-reset", { method: "POST" })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      deletedWorkspaceCount: 1,
    })

    const workspacesResponse = await app.fetch(new Request("http://localhost:7332/api/workspaces"))
    expect(workspacesResponse.status).toBe(200)
    expect(await workspacesResponse.json()).toEqual([])

    const onboardingResponse = await app.fetch(new Request("http://localhost:7332/api/onboarding-status"))
    expect(onboardingResponse.status).toBe(200)
    expect(await onboardingResponse.json()).toEqual({ completed: false })

    expect(existsSync(workspacePath)).toBe(true)

    const workspaceResponse = await app.fetch(
      new Request(`http://localhost:7332/api/workspaces/${workspaceId}`)
    )
    expect(workspaceResponse.status).toBe(404)
  })
})
