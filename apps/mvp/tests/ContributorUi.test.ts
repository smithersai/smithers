import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { Auth } from "../src/features/auth/auth.vibe"
import { AuthProvider } from "../src/features/auth/components/AuthContext"
import { ComposerGate } from "../src/features/auth/components/ComposerGate"
import { AuthStore, SESSION } from "../src/features/auth/store.vibe"
import { BillingProvider } from "../src/features/billing/components/BillingContext"
import { BillingSettings } from "../src/features/billing/components/BillingSettings"
import { BILLING_ACCOUNT_ROUTE, COMPUTE_PACKS, MICRO_USD_PER_USD } from "../src/features/billing/contract"
import { Billing } from "../src/features/billing/store.vibe"
import { ForkActions } from "../src/features/fork/components/ForkActions"
import { ForkProvider } from "../src/features/fork/components/ForkContext"
import { forkRoute } from "../src/features/fork/contract"
import { Fork } from "../src/features/fork/store.vibe"
import { Landing } from "../src/screens/landing/Landing"
import { nodeDevice, openTestApp } from "../src/test/chatApi"

const renderWithRouter = async (component: () => ReturnType<typeof createElement>, initial = "/") => {
  const root = createRootRoute({ component })
  const settingsRoute = createRoute({ getParentRoute: () => root, path: "/app/settings", component: () => null })
  const appRoute = createRoute({ getParentRoute: () => root, path: "/app", component: () => null })
  const waitlistRoute = createRoute({ getParentRoute: () => root, path: "/app/waitlist", component: () => null })
  const repoRoute = createRoute({ getParentRoute: () => root, path: "/$owner/$repo", component: () => null })
  const routeTree = root.addChildren([appRoute, settingsRoute, waitlistRoute, repoRoute])
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [initial] }) })
  await router.load()
  return renderToStaticMarkup(createElement(RouterProvider, { router }))
}

describe("3rd-party contributor UI surfaces", () => {
  test("Landing renders the three contributor paths (BYOA Free, Fork & maintain, Cloud sandboxes)", async () => {
    const app = openTestApp({ answers: false, host: nodeDevice() })
    try {
      const auth = await app.runPromise(Effect.service(Auth))
      auth.queries.session.startSyncImmediate()
      const html = await renderWithRouter(() => createElement(AuthProvider, { value: auth }, createElement(Landing)))
      expect(html).toContain("Bring your own agent")
      expect(html).toContain("Free")
      expect(html).toContain("Fork &amp; maintain")
      expect(html).toContain("Cloud sandboxes")
      expect(html).toContain("~$0.15/hr")
    } finally {
      await app.dispose()
    }
  }, 60_000)

  test("ComposerGate shows Members can ask Smithers. with an actionable Settings link for non-members", async () => {
    const app = openTestApp({ answers: false, host: nodeDevice() })
    try {
      const auth = await app.runPromise(Effect.service(Auth))
      const store = await app.runPromise(Effect.service(AuthStore))
      auth.queries.session.startSyncImmediate()
      auth.queries.confirmed.startSyncImmediate()
      await app.runPromise(
        store.session.update(SESSION, (row) => {
          row.status = "signed_in"
          row.role = null
          row.login = "outside-contrib"
          row.computeAccess = "none"
          row.computeBalanceMicroUsd = 0
        }),
      )
      const html = await renderWithRouter(() =>
        createElement(
          AuthProvider,
          { value: auth },
          createElement(ComposerGate, null, createElement("textarea")),
        ),
      )
      expect(html).toContain("Members can ask Smithers.")
      expect(html).toContain("Connect agent or add credits")
      expect(html).not.toContain("<textarea")
    } finally {
      await app.dispose()
    }
  }, 60_000)

  test("BillingSettings renders prepaid packs, balance, and admin grant form cleanly", async () => {
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
                ledger: [
                  {
                    id: "l-1",
                    kind: "topup",
                    amountMicroUsd: 10 * MICRO_USD_PER_USD,
                    balanceAfterMicroUsd: 10 * MICRO_USD_PER_USD,
                    description: "Cloud credit top-up ($10)",
                    createdAt: new Date().toISOString(),
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        )
      }
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 404 })))
    })
    const rt = ManagedRuntime.make(
      Billing.live({ origin: "https://smithers.sh", within: "5 seconds" }).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      ),
    )
    try {
      const billing = await rt.runPromise(Billing)
      await billing.queries.state.preload()
      await billing.actions.load()
      const html = await renderWithRouter(() =>
        createElement(BillingProvider, { value: billing }, createElement(BillingSettings, { admin: true })),
      )
      expect(html).toContain("Cloud compute &amp; credits")
      expect(html).toContain("$10.00")
      expect(html).toContain("Add $10")
      expect(html).toContain("Add $25")
      expect(html).toContain("Add $50")
      expect(html).toContain("Grant credits")
    } finally {
      await rt.dispose()
    }
  })

  test("ForkActions renders Fork for non-maintainers and Sync upstream / Open upstream PR on a fork", async () => {
    const http = HttpClient.make((req) => {
      if (req.url.endsWith(forkRoute("alice", "smithers"))) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(
              JSON.stringify({
                status: "none",
                isFork: true,
                upstreamOwner: "smithersai",
                upstreamName: "smithers",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          ),
        )
      }
      return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ status: "none" }), { status: 200 })))
    })
    const rt = ManagedRuntime.make(
      Fork.live({ origin: "https://smithers.sh", within: "5 seconds" }).pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
      ),
    )
    try {
      const fork = await rt.runPromise(Fork)
      await fork.queries.all.preload()
      const nonMaintHtml = await renderWithRouter(() =>
        createElement(
          ForkProvider,
          { value: fork },
          createElement(ForkActions, {
            owner: "smithersai",
            name: "smithers",
            defaultBranch: "main",
            isMaintainer: false,
            signedIn: true,
            login: "alice",
          }),
        ),
      )
      expect(nonMaintHtml).toContain("Fork")

      await fork.actions.load("alice", "smithers")
      const onForkHtml = await renderWithRouter(() =>
        createElement(
          ForkProvider,
          { value: fork },
          createElement(ForkActions, {
            owner: "alice",
            name: "smithers",
            defaultBranch: "main",
            isMaintainer: true,
            signedIn: true,
            login: "alice",
          }),
        ),
      )
      expect(onForkHtml).toContain("Sync upstream")
      expect(onForkHtml).toContain("Open upstream PR")
    } finally {
      await rt.dispose()
    }
  })
})
