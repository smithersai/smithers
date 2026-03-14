import { describe, expect, it } from "bun:test"

import type { DaemonRuntimeHandle } from "../../daemon/src/bootstrap/daemon-lifecycle"
import {
  DEFAULT_DESKTOP_DAEMON_URL,
  DesktopDaemonAlreadyRunningError,
  resolveDesktopDaemonRuntime,
} from "./daemon-runtime"

function buildSpawnedRuntime(url = DEFAULT_DESKTOP_DAEMON_URL): DaemonRuntimeHandle {
  return {
    server: {
      fetch: () => new Response(null, { status: 200 }),
      port: 7332,
      stop: () => {},
    },
    port: 7332,
    url,
    healthUrl: `${url}/api/health`,
    startedAt: new Date(0).toISOString(),
    stop: async () => {},
  }
}

describe("desktop daemon runtime resolution", () => {
  it("throws when Burns is already running on the configured port by default", async () => {
    const started: string[] = []
    await expect(
      resolveDesktopDaemonRuntime({
        daemonUrlEnv: undefined,
        fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        start: async () => {
          started.push("called")
          return buildSpawnedRuntime()
        },
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "DesktopDaemonAlreadyRunningError",
        daemonUrl: DEFAULT_DESKTOP_DAEMON_URL,
      })
    )

    expect(started).toEqual([])
  })

  it("can attach to an existing daemon when explicitly allowed", async () => {
    const started: string[] = []
    const runtime = await resolveDesktopDaemonRuntime({
      daemonUrlEnv: undefined,
      allowAttachToExisting: true,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      start: async () => {
        started.push("called")
        return buildSpawnedRuntime()
      },
    })

    expect(runtime.source).toBe("existing")
    expect(runtime.url).toBe(DEFAULT_DESKTOP_DAEMON_URL)
    expect(started).toEqual([])
  })

  it("spawns and manages a daemon when no existing daemon is reachable", async () => {
    const spawnedRuntime = buildSpawnedRuntime("http://localhost:7444")
    const runtime = await resolveDesktopDaemonRuntime({
      fetchImpl: async () => new Response(null, { status: 503 }),
      start: async () => spawnedRuntime,
    })

    expect(runtime.source).toBe("spawned")
    expect(runtime.url).toBe("http://localhost:7444")
  })

  it("recovers from EADDRINUSE by attaching to daemon once health endpoint becomes reachable in attach-allowed mode", async () => {
    let healthChecks = 0
    const runtime = await resolveDesktopDaemonRuntime({
      allowAttachToExisting: true,
      fetchImpl: async () => {
        healthChecks += 1
        if (healthChecks >= 2) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }

        return new Response(null, { status: 503 })
      },
      start: async () => {
        throw Object.assign(new Error("Failed to start server. Is port 7332 in use?"), {
          code: "EADDRINUSE",
        })
      },
    })

    expect(runtime.source).toBe("existing")
    expect(runtime.url).toBe(DEFAULT_DESKTOP_DAEMON_URL)
  })

  it("throws a structured already-running error after EADDRINUSE when Burns becomes reachable", async () => {
    let healthChecks = 0

    await expect(
      resolveDesktopDaemonRuntime({
        fetchImpl: async () => {
          healthChecks += 1
          if (healthChecks >= 2) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
          }

          return new Response(null, { status: 503 })
        },
        start: async () => {
          throw Object.assign(new Error("Failed to start server. Is port 7332 in use?"), {
            code: "EADDRINUSE",
          })
        },
      })
    ).rejects.toBeInstanceOf(DesktopDaemonAlreadyRunningError)
  })

  it("throws startup errors that are not address-in-use failures", async () => {
    const expectedError = new Error("boom")
    expect(
      resolveDesktopDaemonRuntime({
        fetchImpl: async () => new Response(null, { status: 503 }),
        start: async () => {
          throw expectedError
        },
      })
    ).rejects.toBe(expectedError)
  })
})
