import { describe, expect, it } from "bun:test"
import type { Workspace } from "@burns/shared"

import { DAEMON_HEALTH_PATH } from "@/server/routes/health-routes"

import { createDaemonLifecycle } from "./daemon-lifecycle"

describe("daemon lifecycle", () => {
  it("captures startup metadata and initializes workspace boot dependencies", async () => {
    const fixedNow = new Date("2026-03-12T10:30:00.000Z").valueOf()
    const workspaceSnapshot: Workspace[] = [
      {
        id: "workspace-1",
        name: "Workspace One",
        path: "/tmp/workspace-1",
        healthStatus: "healthy",
        sourceType: "create",
        runtimeMode: "burns-managed",
        createdAt: "2026-03-12T10:29:59.000Z",
        updatedAt: "2026-03-12T10:29:59.000Z",
      },
    ]
    let initializeCalls = 0
    let listCalls = 0
    let pruneCalls = 0
    let monitorStarts = 0
    let monitorStops = 0
    const warmCalls: unknown[][] = []
    const serveCalls: Array<{ port: number; idleTimeout?: number }> = []

    const lifecycle = createDaemonLifecycle({
      now: () => fixedNow,
      createApp: ({ port }) => ({
        port: port ?? 7332,
        fetch: async (_request: Request) => Response.json({ ok: true }),
      }),
      serve: ({ port, idleTimeout }) => {
        serveCalls.push({ port, idleTimeout })
        return {
          port,
          fetch: async (_request: Request) => Response.json({ ok: true }),
          stop: () => undefined,
        }
      },
      initializeWorkspaceService: () => {
        initializeCalls += 1
      },
      pruneMissingWorkspaces: async () => {
        pruneCalls += 1
        return {
          checkedWorkspaces: workspaceSnapshot.length,
          removedWorkspaces: 0,
          failedWorkspaces: 0,
        }
      },
      startMissingWorkspaceMonitor: () => {
        monitorStarts += 1
        return () => {
          monitorStops += 1
        }
      },
      listWorkspaces: () => {
        listCalls += 1
        return workspaceSnapshot
      },
      warmWorkspaceSmithersInstances: async (workspaces) => {
        warmCalls.push(workspaces)
      },
      shutdownWorkspaceSmithersInstances: async () => undefined,
    })

    const runtime = await lifecycle.start()

    expect(runtime.port).toBe(7332)
    expect(runtime.url).toBe("http://localhost:7332")
    expect(runtime.healthUrl).toBe(`http://localhost:7332${DAEMON_HEALTH_PATH}`)
    expect(runtime.startedAt).toBe("2026-03-12T10:30:00.000Z")
    expect(typeof runtime.stop).toBe("function")

    expect(initializeCalls).toBe(1)
    expect(pruneCalls).toBe(1)
    expect(monitorStarts).toBe(1)
    expect(listCalls).toBe(1)
    expect(warmCalls).toEqual([workspaceSnapshot])
    expect(serveCalls).toEqual([{ port: 7332, idleTimeout: 255 }])

    await runtime.stop()
    expect(monitorStops).toBe(1)
  })

  it("stops idempotently even when stop is called concurrently", async () => {
    let serverStopCalls = 0
    let smithersShutdownCalls = 0

    const lifecycle = createDaemonLifecycle({
      createApp: ({ port }) => ({
        port: port ?? 7332,
        fetch: async (_request: Request) => Response.json({ ok: true }),
      }),
      serve: ({ port }) => ({
        port,
        fetch: async (_request: Request) => Response.json({ ok: true }),
        stop: () => {
          serverStopCalls += 1
        },
      }),
      initializeWorkspaceService: () => undefined,
      pruneMissingWorkspaces: async () => ({
        checkedWorkspaces: 0,
        removedWorkspaces: 0,
        failedWorkspaces: 0,
      }),
      startMissingWorkspaceMonitor: () => () => undefined,
      listWorkspaces: () => [],
      warmWorkspaceSmithersInstances: async () => undefined,
      shutdownWorkspaceSmithersInstances: async () => {
        smithersShutdownCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
      },
    })

    await lifecycle.start()

    await Promise.all([lifecycle.stop({ signal: "SIGTERM" }), lifecycle.stop({ signal: "SIGINT" })])

    expect(serverStopCalls).toBe(1)
    expect(smithersShutdownCalls).toBe(1)
    expect(lifecycle.getRuntime()).toBeNull()

    await lifecycle.stop({ signal: "programmatic" })

    expect(serverStopCalls).toBe(1)
    expect(smithersShutdownCalls).toBe(1)
  })

  it("supports an explicit port override", async () => {
    const createAppPorts: number[] = []

    const lifecycle = createDaemonLifecycle({
      createApp: ({ port }) => {
        const resolvedPort = port ?? 7332
        createAppPorts.push(resolvedPort)
        return {
          port: resolvedPort,
          fetch: async (_request: Request) => Response.json({ ok: true }),
        }
      },
      serve: ({ port }) => ({
        port,
        fetch: async (_request: Request) => Response.json({ ok: true }),
        stop: () => undefined,
      }),
      initializeWorkspaceService: () => undefined,
      pruneMissingWorkspaces: async () => ({
        checkedWorkspaces: 0,
        removedWorkspaces: 0,
        failedWorkspaces: 0,
      }),
      startMissingWorkspaceMonitor: () => () => undefined,
      listWorkspaces: () => [],
      warmWorkspaceSmithersInstances: async () => undefined,
      shutdownWorkspaceSmithersInstances: async () => undefined,
    })

    const runtime = await lifecycle.start({ port: 8123 })

    expect(createAppPorts).toEqual([8123])
    expect(runtime.port).toBe(8123)
    expect(runtime.healthUrl).toBe(`http://localhost:8123${DAEMON_HEALTH_PATH}`)
  })
})
