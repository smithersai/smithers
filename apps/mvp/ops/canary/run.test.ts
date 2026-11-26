import { Channels } from "@smthrs/notifications"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_CANARY_CHECKS,
  formatCanaryAlert,
  notifyCanaryFailure,
  runCanary,
  type CanaryFetch,
} from "./run"

describe("ops/canary/run", () => {
  it("passes all default production checks when SPA routes return 200, version.json returns build, and Smithers-Ops fails closed", async () => {
    let tick = 1000
    const seenRedirects: Array<string> = []
    const fetchImpl: CanaryFetch = async (url, init) => {
      seenRedirects.push(init.redirect)
      if (url.endsWith("/version.json")) {
        return { status: 200, json: async () => ({ build: "3b38cfaf9f4e" }) }
      }
      if (url.includes("/Smithers-Ops/")) {
        return { status: url.includes("/plan/") ? 401 : 404, json: async () => ({}) }
      }
      return { status: 200, json: async () => ({}) }
    }

    const summary = await runCanary({
      origin: "https://smithers.sh/",
      fetchImpl,
      now: () => (tick += 10),
    })

    expect(summary.ok).toBe(true)
    expect(summary.origin).toBe("https://smithers.sh")
    expect(summary.build).toBe("3b38cfaf9f4e")
    expect(summary.passed).toBe(DEFAULT_CANARY_CHECKS.length)
    expect(summary.failed).toBe(0)
    expect(seenRedirects.every((mode) => mode === "manual")).toBe(true)
    expect(formatCanaryAlert(summary)).toBe(
      `Canary healthy on https://smithers.sh (build 3b38cfaf9f4e): ${DEFAULT_CANARY_CHECKS.length}/${DEFAULT_CANARY_CHECKS.length} passed.`,
    )
  })

  it("flags redirects, non-200 SPA pages, open private routes, bad version.json, and transport errors", async () => {
    const fetchImpl: CanaryFetch = async (url) => {
      if (url.endsWith("/redirect")) return { status: 308, json: async () => ({}) }
      if (url.endsWith("/missing")) return { status: 404, json: async () => ({}) }
      if (url.endsWith("/private-open")) return { status: 200, json: async () => ({}) }
      if (url.endsWith("/version-redir")) return { status: 301, json: async () => ({}) }
      if (url.endsWith("/version-500")) return { status: 500, json: async () => ({}) }
      if (url.endsWith("/version-bad-json")) return { status: 200, json: async () => { throw new Error("bad") } }
      if (url.endsWith("/version-empty")) return { status: 200, json: async () => ({ build: "   " }) }
      if (url.endsWith("/version-null")) return { status: 200, json: async () => null }
      throw new Error("ECONNREFUSED")
    }

    const summary = await runCanary({
      origin: "https://smithers.sh",
      checks: [
        { id: "r1", path: "/redirect", kind: "spa_200" },
        { id: "r2", path: "/missing", kind: "spa_200" },
        { id: "p1", path: "/private-open", kind: "fail_closed" },
        { id: "v1", path: "/version-redir", kind: "version_json" },
        { id: "v2", path: "/version-500", kind: "version_json" },
        { id: "v3", path: "/version-bad-json", kind: "version_json" },
        { id: "v4", path: "/version-empty", kind: "version_json" },
        { id: "v5", path: "/version-null", kind: "version_json" },
        { id: "t1", path: "/down", kind: "spa_200" },
      ],
      fetchImpl,
    })

    expect(summary.ok).toBe(false)
    expect(summary.build).toBeNull()
    expect(summary.failed).toBe(9)
    expect(summary.results.map((item) => item.reason)).toEqual([
      "unexpected_redirect",
      "unexpected_status",
      "private_route_not_closed",
      "unexpected_redirect",
      "unexpected_status",
      "invalid_version_json",
      "missing_build_id",
      "missing_build_id",
      "transport_error",
    ])
    const alert = formatCanaryAlert(summary)
    expect(alert).toContain("Canary FAILED on https://smithers.sh (build unknown): 9 failed")
    expect(alert).toContain("r1=308(unexpected_redirect)")
    expect(alert).toContain("p1=200(private_route_not_closed)")
    expect(alert).toContain("t1=err(transport_error)")
  })

  it("uses default fetch and Date.now cleanly when omitted and handles missing reason fallback", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => ({ status: 403, json: async () => ({}) })) as unknown as typeof globalThis.fetch
    try {
      const summary = await runCanary({
        origin: "https://smithers.sh",
        checks: [{ id: "closed-403", path: "/api/repos/smithersai/Smithers-Ops/plan/snapshot", kind: "fail_closed" }],
      })
      expect(summary.ok).toBe(true)
      expect(summary.results[0]?.status).toBe(403)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(
      formatCanaryAlert({
        origin: "https://smithers.sh",
        build: "abc123",
        ok: false,
        passed: 0,
        failed: 1,
        results: [{ id: "x", path: "/x", ok: false, status: 502, durationMs: 5 }],
      }),
    ).toBe("Canary FAILED on https://smithers.sh (build abc123): 1 failed [x=502(failed)].")
  })
  it("skips healthy or unconfigured alerts and delivers failures through @smthrs/notifications", async () => {
    const sent: Array<{ readonly dest: unknown; readonly msg: unknown }> = []
    const okChannels = Layer.succeed(Channels.Channels, {
      send: (dest, msg) => Effect.sync(() => {
        sent.push({ dest, msg })
        return { providerId: "tg-1" }
      }),
    })
    const failingChannels = Layer.succeed(Channels.Channels, {
      send: () => Effect.fail(new Channels.DeliveryFailed({ channel: "telegram", code: "unreachable", reason: "down" })),
    })
    const refusedChannels = Layer.succeed(Channels.Channels, {
      send: () => Effect.fail(new Channels.DeliveryRefused({ channel: "telegram", code: "rejected", reason: "bad_chat" })),
    })

    const healthy: Parameters<typeof notifyCanaryFailure>[0] = {
      origin: "https://smithers.sh",
      build: "abc123",
      ok: true,
      passed: 1,
      failed: 0,
      results: [{ id: "root", path: "/", ok: true, status: 200, durationMs: 5 }],
    }
    const broken: Parameters<typeof notifyCanaryFailure>[0] = {
      origin: "https://smithers.sh",
      build: "abc123",
      ok: false,
      passed: 0,
      failed: 1,
      results: [{ id: "root", path: "/", ok: false, status: 500, durationMs: 5, reason: "unexpected_status" }],
    }
    const brokenUnknownBuild: Parameters<typeof notifyCanaryFailure>[0] = {
      ...broken,
      build: null,
    }

    expect(await Effect.runPromise(notifyCanaryFailure(healthy, "12345").pipe(Effect.provide(okChannels)))).toEqual({
      delivered: false,
      skippedReason: "healthy",
    })
    expect(await Effect.runPromise(notifyCanaryFailure(broken, "   ").pipe(Effect.provide(okChannels)))).toEqual({
      delivered: false,
      skippedReason: "unconfigured",
    })
    expect(await Effect.runPromise(notifyCanaryFailure(broken, " 12345 ").pipe(Effect.provide(okChannels)))).toEqual({
      delivered: true,
    })
    expect(await Effect.runPromise(notifyCanaryFailure(brokenUnknownBuild, "12345").pipe(Effect.provide(okChannels)))).toEqual({
      delivered: true,
    })
    expect(sent[0]).toEqual({
      dest: { _tag: "telegram", chatId: "12345" },
      msg: {
        id: "canary-abc123-1",
        subject: "Canary failed on https://smithers.sh",
        text: "Canary FAILED on https://smithers.sh (build abc123): 1 failed [root=500(unexpected_status)].",
      },
    })
    expect(sent[1]?.msg).toMatchObject({ id: "canary-unknown-1" })
    expect(await Effect.runPromise(notifyCanaryFailure(broken, "12345").pipe(Effect.provide(failingChannels)))).toEqual({
      delivered: false,
      errorTag: "@smthrs/notifications/DeliveryFailed",
    })
    expect(await Effect.runPromise(notifyCanaryFailure(broken, "12345").pipe(Effect.provide(refusedChannels)))).toEqual({
      delivered: false,
      errorTag: "@smthrs/notifications/DeliveryRefused",
    })
  })
})
