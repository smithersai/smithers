import { Effect, Layer, ManagedRuntime } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { afterEach, describe, expect, test } from "vitest"
import { mayRunMachines } from "../auth/contract"
import {
  BILLING_ACCOUNT_ROUTE,
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

describe("billing contract & pricing", () => {
  test("computes 2x Cloudflare Container rates and formats micro-USD cleanly", () => {
    const raw = rawUsdPerSecond("standard-1")
    expect(raw).toBeCloseTo(0.00002056, 8)
    expect(hourlyUsd("standard-1", 2)).toBeCloseTo(0.148032, 5)
    expect(paidMicroUsdPerSecond("standard-1", 2)).toBeCloseTo(41.12, 2)
    expect(chargeMicroUsd("standard-1", 60, 2)).toBe(Math.ceil(41.12 * 60))
    expect(chargeMicroUsd("standard-1", 0, 2)).toBe(0)
    expect(chargeMicroUsd("standard-1", -10, 2)).toBe(0)
    expect(formatUsd(0)).toBe("$0.00")
    expect(formatUsd(10 * MICRO_USD_PER_USD)).toBe("$10.00")
    expect(formatUsd(-250_000)).toBe("-$0.25")
    expect(formatUsd(500)).toBe("$0.0005")
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
})

describe("Billing browser store", () => {
  test("loads account state and launches checkout redirect", async () => {
    const redirected: Array<string> = []
    const http = HttpClient.make((req) => {
      if (req.url.endsWith(BILLING_ACCOUNT_ROUTE)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(
              JSON.stringify({
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
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
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
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 404 })))
    })

    const rt = ManagedRuntime.make(
      Billing.live({
        origin: "https://smithers.sh",
        within: "5 seconds",
        redirect: (url) => redirected.push(url),
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
    )
    runtimes.push(rt)
    const view = await rt.runPromise(Billing)
    await view.queries.state.preload()
    await view.actions.load()
    const row = view.queries.state.get(BILLING)
    expect(row?.status).toBe("ready")
    expect(row?.account?.computeAccess).toBe("paid")
    expect(row?.account?.balanceMicroUsd).toBe(10 * MICRO_USD_PER_USD)

    await view.actions.checkout("pack_10")
    expect(redirected).toEqual(["https://checkout.stripe.com/c/pay/cs_1"])
  })
})
