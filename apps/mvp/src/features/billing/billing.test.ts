import { Effect, Layer, ManagedRuntime } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { afterEach, describe, expect, test } from "vitest"
import { mayRunMachines } from "../auth/contract"
import { openBrowserTab, redirectBrowser } from "./browserNav"
import {
  BILLING_ACCOUNT_ROUTE,
  BILLING_ADMIN_GRANT_ROUTE,
  BILLING_CHECKOUT_ROUTE,
  chargeMicroUsd,
  COMPUTE_PACKS,
  formatUsd,
  hourlyUsd,
  MICRO_USD_PER_USD,
  packById,
  paidMicroUsdPerSecond,
  rawUsdPerSecond,
} from "./contract"
import { BILLING, Billing } from "./store.vibe"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const rt of runtimes.splice(0).reverse()) await rt.dispose()
})

const sampleAccount = {
  balanceMicroUsd: 10 * MICRO_USD_PER_USD,
  lifetimePurchasedMicroUsd: 10 * MICRO_USD_PER_USD,
  lifetimeSpentMicroUsd: 0,
  computeAccess: "paid",
  isDeploymentMember: false,
  minAdmitMicroUsd: 50_000,
  stripeConfigured: true,
  priceMultiplier: 2,
  defaultInstance: "standard-1",
  rates: [{ instance: "standard-1", vcpu: 0.5, memoryGib: 4, hourlyUsd: 0.148 }],
  packs: COMPUTE_PACKS,
  ledger: [],
}

describe("billing contract, pricing, and browserNav", () => {
  test("computes 2x Cloudflare Container rates, unknown instance fallback, and formats micro-USD cleanly", () => {
    const raw = rawUsdPerSecond("standard-1")
    expect(raw).toBeCloseTo(0.00002056, 8)
    expect(rawUsdPerSecond("unknown-huge")).toBe(rawUsdPerSecond("standard-4"))
    expect(hourlyUsd("standard-1", 2)).toBeCloseTo(0.148032, 5)
    expect(paidMicroUsdPerSecond("standard-1", 2)).toBeCloseTo(41.12, 2)
    expect(chargeMicroUsd("standard-1", 60, 2)).toBe(Math.ceil(41.12 * 60))
    expect(chargeMicroUsd("standard-1", 0, 2)).toBe(0)
    expect(chargeMicroUsd("standard-1", -10, 2)).toBe(0)
    expect(formatUsd(0)).toBe("$0.00")
    expect(formatUsd(10 * MICRO_USD_PER_USD)).toBe("$10.00")
    expect(formatUsd(-250_000)).toBe("-$0.25")
    expect(formatUsd(500)).toBe("$0.0005")
    expect(formatUsd(-500)).toBe("-$0.0005")
    expect(packById("pack_25")?.amountUsd).toBe(25)
    expect(packById("unknown")).toBeUndefined()
  })

  test("mayRunMachines admits deployment members and paid contributors, denies unpaid guests", () => {
    expect(mayRunMachines({ role: "admin" })).toBe(true)
    expect(mayRunMachines({ role: "member" })).toBe(true)
    expect(mayRunMachines({ role: null, computeAccess: "paid" })).toBe(true)
    expect(mayRunMachines({ role: "guest", computeAccess: "paid" })).toBe(true)
    expect(mayRunMachines({ role: null, computeAccess: "none" })).toBe(false)
    expect(mayRunMachines({ role: "guest" })).toBe(false)
  })

  test("browserNav no-ops without window and invokes location.assign / window.open when window exists", () => {
    expect(() => redirectBrowser("https://checkout.stripe.com/x")).not.toThrow()
    expect(() => openBrowserTab("https://github.com/org/repo/fork")).not.toThrow()
    const assigned: Array<string> = []
    const opened: Array<Array<string>> = []
    const prev = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      location: { assign: (url: string) => assigned.push(url) },
      open: (url: string, target: string, rel: string) => opened.push([url, target, rel]),
    }
    try {
      redirectBrowser("https://checkout.stripe.com/pay")
      openBrowserTab("https://github.com/org/repo/fork")
      expect(assigned).toEqual(["https://checkout.stripe.com/pay"])
      expect(opened).toEqual([["https://github.com/org/repo/fork", "_blank", "noopener,noreferrer"]])
    } finally {
      if (prev === undefined) delete (globalThis as { window?: unknown }).window
      else (globalThis as { window?: unknown }).window = prev
    }
  })
})

describe("Billing browser store", () => {
  const makeStore = (
    handler: (req: Parameters<Parameters<typeof HttpClient.make>[0]>[0]) => ReturnType<Parameters<typeof HttpClient.make>[0]>,
    redirected?: Array<string>,
  ) => {
    const http = HttpClient.make(handler)
    const rt = ManagedRuntime.make(
      Billing.live({
        origin: "https://smithers.sh",
        within: "5 seconds",
        ...(redirected === undefined ? {} : { redirect: (url) => redirected.push(url) }),
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
    )
    runtimes.push(rt)
    return rt.runPromise(Billing)
  }

  test("loads account state, launches checkout redirect, and handles admin grant", async () => {
    const redirected: Array<string> = []
    const view = await makeStore((req) => {
      if (req.url.endsWith(BILLING_ACCOUNT_ROUTE)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify(sampleAccount), { status: 200, headers: { "content-type": "application/json" } }),
          ),
        )
      }
      if (req.url.endsWith(BILLING_CHECKOUT_ROUTE)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ sessionId: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        )
      }
      if (req.url.endsWith(BILLING_ADMIN_GRANT_ROUTE)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ ok: true }), { status: 202, headers: { "content-type": "application/json" } }),
          ),
        )
      }
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 404 })))
    }, redirected)

    await view.queries.state.preload()
    await view.actions.load()
    expect(view.queries.state.get(BILLING)?.status).toBe("ready")
    expect(view.queries.state.get(BILLING)?.account?.computeAccess).toBe("paid")

    await view.actions.checkout("pack_10")
    expect(redirected).toEqual(["https://checkout.stripe.com/c/pay/cs_1"])

    await view.actions.grant({ login: "octocat", amountUsd: 25, note: "Thank you" })
    expect(view.queries.state.get(BILLING)?.grantStatus).toContain("Granted $25")
  })

  test("handles load 401, non-2xx, invalid json, and network failures", async () => {
    let mode: "401" | "500" | "badjson" | "badschema" | "net" = "401"
    const view = await makeStore((req) => {
      if (mode === "net") {
        return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: req, cause: new Error("offline") }) }))
      }
      if (mode === "401") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 401 })))
      if (mode === "500") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 500 })))
      if (mode === "badjson") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("not-json", { status: 200 })))
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ bad: true }), { status: 200 })))
    })
    await view.queries.state.preload()

    mode = "401"
    await view.actions.load()
    expect(view.queries.state.get(BILLING)?.status).toBe("idle")

    mode = "500"
    await view.actions.load()
    expect(view.queries.state.get(BILLING)?.status).toBe("failed")

    mode = "badjson"
    await view.actions.load()
    expect(view.queries.state.get(BILLING)?.status).toBe("failed")

    mode = "badschema"
    await view.actions.load()
    expect(view.queries.state.get(BILLING)?.status).toBe("failed")

    mode = "net"
    await view.actions.load()
    expect(view.queries.state.get(BILLING)?.status).toBe("failed")
  })

  test("handles checkout and grant error paths cleanly", async () => {
    let mode: "503" | "500plain" | "500empty" | "400" | "404" | "403" | "badjson" | "badschema" | "net" = "503"
    const view = await makeStore((req) => {
      if (mode === "net") {
        return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: req, cause: new Error("offline") }) }))
      }
      if (mode === "500plain") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("plain error", { status: 500 })))
      if (mode === "500empty") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 500 })))
      if (mode === "503") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ code: "not_configured" }), { status: 503 })))
      if (mode === "400") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ code: "invalid_pack" }), { status: 400 })))
      if (mode === "404") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ code: "not_found" }), { status: 404 })))
      if (mode === "403") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ code: "forbidden" }), { status: 403 })))
      if (mode === "badjson") return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("nope", { status: 200 })))
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ nope: true }), { status: 200 })))
    })
    await view.queries.state.preload()

    mode = "503"
    await view.actions.checkout("pack_10")
    expect(view.queries.state.get(BILLING)?.checkoutError).toBe("not_configured")

    mode = "400"
    await view.actions.checkout("pack_10")
    expect(view.queries.state.get(BILLING)?.checkoutError).toBe("invalid_pack")

    mode = "badjson"
    await view.actions.checkout("pack_10")
    expect(view.queries.state.get(BILLING)?.checkoutError).toBe("invalid")

    mode = "badschema"
    await view.actions.checkout("pack_10")
    expect(view.queries.state.get(BILLING)?.checkoutError).toBe("invalid")

    mode = "net"
    await view.actions.checkout("pack_10")
    expect(view.queries.state.get(BILLING)?.checkoutError).toBe("unavailable")

    mode = "404"
    await view.actions.grant({ login: "nobody", amountUsd: 10, note: "" })
    expect(view.queries.state.get(BILLING)?.grantStatus).toContain("User not found")

    mode = "403"
    await view.actions.grant({ login: "octocat", amountUsd: 10, note: "" })
    expect(view.queries.state.get(BILLING)?.grantStatus).toContain("forbidden")

    mode = "400"
    await view.actions.grant({ login: "octocat", amountUsd: 10, note: "" })
    expect(view.queries.state.get(BILLING)?.grantStatus).toContain("invalid_pack")

    mode = "500plain"
    await view.actions.checkout("pack_10")
    expect(view.queries.state.get(BILLING)?.checkoutError).toBe("unavailable")
    await view.actions.grant({ login: "octocat", amountUsd: 10, note: "" })
    expect(view.queries.state.get(BILLING)?.grantStatus).toContain("failed")

    mode = "500empty"
    await view.actions.checkout("pack_10")
    expect(view.queries.state.get(BILLING)?.checkoutError).toBe("unavailable")
    await view.actions.grant({ login: "octocat", amountUsd: 10, note: "" })
    expect(view.queries.state.get(BILLING)?.grantStatus).toContain("failed")

    mode = "net"
    await view.actions.grant({ login: "octocat", amountUsd: 10, note: "" })
    expect(view.queries.state.get(BILLING)?.grantStatus).toContain("Couldn't reach")
  })
})
