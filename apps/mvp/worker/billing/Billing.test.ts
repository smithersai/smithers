import { runFlow } from "../test/flowHost.ts"
import { Effect, Layer, Option, Redacted } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import {
  BILLING_ACCOUNT_ROUTE,
  BILLING_ADMIN_GRANT_ROUTE,
  BILLING_CHECKOUT_ROUTE,
  BILLING_WEBHOOK_ROUTE,
  chargeMicroUsd,
  MICRO_USD_PER_USD,
  MIN_ADMIT_MICRO_USD,
} from "../../src/features/billing/contract.ts"
import { type Actor, Sessions } from "../Actor.vibe"
import * as Budget from "../branch/Budget.vibe"
import * as Flows from "../Flows.vibe"
import * as BillingApi from "./BillingApi.vibe"
import * as BillingFlows from "./BillingFlows.vibe"
import { BillingProvider, disabledLayer } from "./BillingProvider.ts"
import * as BillingStore from "./BillingStore.vibe"
import * as ComputeAccess from "./ComputeAccess.vibe"
import { computeStripeHmacHex, parseStripeSignature, timingSafeEqualHex } from "./StripeCrypto.ts"
import * as StripeProvider from "./StripeProvider.vibe"

const sessionOf = (actor: Actor | undefined) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      resolve: Effect.succeed(actor === undefined ? Option.none() : Option.some(actor)),
    }),
  )

const seedPerson = (sql: SqlClient.SqlClient, githubId: number, login: string) => {
  const id = crypto.randomUUID()
  return sql<{ readonly id: string }>`
    INSERT INTO people (id, github_id, github_login)
    VALUES (${id}::uuid, ${githubId}, ${login})
    RETURNING id::text AS id`.pipe(Effect.map((rows) => rows[0]!.id))
}

describe("StripeCrypto", () => {
  test("parses valid Stripe-Signature headers and verifies constant-time HMAC", async () => {
    const secret = "whsec_test_secret_12345"
    const ts = Math.floor(Date.now() / 1000)
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" })
    const sig = await computeStripeHmacHex(secret, ts, body)
    const parsed = parseStripeSignature(`t=${ts},v1=${sig}`)
    expect(parsed).toEqual({ timestamp: ts, signatures: [sig] })
    expect(timingSafeEqualHex(sig, sig)).toBe(true)
    expect(timingSafeEqualHex(sig, "0".repeat(64))).toBe(false)
    expect(timingSafeEqualHex("abc", "abcd")).toBe(false)
    expect(parseStripeSignature("invalid")).toBeUndefined()
    expect(parseStripeSignature("t=notanumber,v1=" + sig)).toBeUndefined()
  })
})

describe("StripeProvider", () => {
  test("creates a Checkout session and verifies signed webhooks", async () => {
    const secret = "whsec_provider_test_secret"
    let seenUrl = ""
    let seenAuth = ""
    let seenBody = ""
    const fakeHttp = HttpClient.make((req) => {
      seenUrl = req.url
      seenAuth = req.headers.authorization ?? ""
      seenBody = req.body._tag === "Uint8Array" ? new TextDecoder().decode(req.body.body) : ""
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          req,
          new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      )
    })
    const layer = StripeProvider.make(
      {
        secretKey: Redacted.make("sk_test_key"),
        webhookSecret: Option.some(Redacted.make(secret)),
        apiUrl: "https://api.stripe.test",
      },
      fakeHttp,
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* BillingProvider
        expect(provider.configured).toBe(true)
        const session = yield* provider.createCheckoutSession({
          personId: "11111111-1111-1111-1111-111111111111",
          login: "alice",
          packId: "pack_10",
          packLabel: "$10",
          amountCents: 1000,
          amountMicroUsd: 10 * MICRO_USD_PER_USD,
          successUrl: "https://smithers.sh/app/settings?billing=success",
          cancelUrl: "https://smithers.sh/app/settings?billing=canceled",
        })
        const ts = Math.floor(Date.now() / 1000)
        const payload = JSON.stringify({
          id: "evt_topup_1",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_123",
              payment_status: "paid",
              customer: "cus_abc",
              metadata: {
                person_id: "11111111-1111-1111-1111-111111111111",
                pack_id: "pack_10",
              },
            },
          },
        })
        const sig = yield* Effect.promise(() => computeStripeHmacHex(secret, ts, payload))
        const event = yield* provider.verifyWebhook(payload, `t=${ts},v1=${sig}`)
        const badExit = yield* provider.verifyWebhook(payload, `t=${ts},v1=${"0".repeat(64)}`).pipe(Effect.exit)
        const oldExit = yield* provider.verifyWebhook(payload, `t=${ts - 600},v1=${sig}`).pipe(Effect.exit)
        return { session, event, badExit, oldExit }
      }).pipe(Effect.provide(layer)),
    )
    expect(seenUrl).toBe("https://api.stripe.test/v1/checkout/sessions")
    expect(seenAuth).toBe("Bearer sk_test_key")
    expect(seenBody).toContain("pack_id")
    expect(result.session.sessionId).toBe("cs_test_123")
    expect(result.event).toEqual({
      kind: "checkout.completed",
      eventId: "evt_topup_1",
      sessionId: "cs_test_123",
      personId: "11111111-1111-1111-1111-111111111111",
      packId: "pack_10",
      amountMicroUsd: 10 * MICRO_USD_PER_USD,
      customerId: "cus_abc",
    })
    expect(result.badExit._tag).toBe("Failure")
    expect(result.oldExit._tag).toBe("Failure")
  })
})

describe("BillingStore, ComputeAccess, Budget paid metering, and BillingApi", () => {
  test("enforces credits, bills paid sandboxes at 2x Cloudflare rate, caps at $0, and handles Stripe webhook & admin grant", async () => {
    const dbLayer = TestDatabase.layer("billing")
    const webhookSecret = "whsec_integration_test_999"
    const stripeLayer = StripeProvider.make(
      {
        secretKey: Redacted.make("sk_test_integration"),
        webhookSecret: Option.some(Redacted.make(webhookSecret)),
        apiUrl: "https://api.stripe.test",
      },
      HttpClient.make((req) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            req,
            new Response(JSON.stringify({ id: "cs_live_1", url: "https://checkout.stripe.com/pay/cs_live_1" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
      ),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const contributorId = yield* seedPerson(sql, 70001, "contrib-alice")
          const adminId = yield* seedPerson(sql, 70002, "admin-will")

          const contributor: Actor = { subject: { kind: "person", id: contributorId }, role: null, login: "contrib-alice" }
          const member: Actor = { subject: { kind: "person", id: adminId }, role: "admin", login: "admin-will" }

          // 1. Initially: deployment member is allowed free; 3rd-party contributor has $0 and is denied.
          expect(yield* ComputeAccess.check(member)).toMatchObject({ allowed: true, mode: "deployment" })
          expect(yield* ComputeAccess.check(contributor)).toMatchObject({ allowed: false, mode: "none", balanceMicroUsd: 0 })

          // 2. Credit idempotency: topping up $10 twice with the same idempotencyKey credits once.
          const first = yield* BillingStore.credit({
            personId: contributorId,
            kind: "topup",
            amountMicroUsd: 10 * MICRO_USD_PER_USD,
            idempotencyKey: "stripe:evt_dup_1",
            description: "Cloud credit top-up ($10)",
          })
          const second = yield* BillingStore.credit({
            personId: contributorId,
            kind: "topup",
            amountMicroUsd: 10 * MICRO_USD_PER_USD,
            idempotencyKey: "stripe:evt_dup_1",
            description: "Cloud credit top-up ($10)",
          })
          expect(first).toEqual({ applied: true, balanceMicroUsd: 10 * MICRO_USD_PER_USD })
          expect(second).toEqual({ applied: false, balanceMicroUsd: 10 * MICRO_USD_PER_USD })

          // 3. Contributor is now authorized for paid compute!
          expect(yield* ComputeAccess.check(contributor)).toMatchObject({
            allowed: true,
            mode: "paid",
            balanceMicroUsd: 10 * MICRO_USD_PER_USD,
          })

          // 4. Paid sandbox generation metering: insert a paid sandbox started 120s ago and settle it via Budget.seen.
          yield* sql`
            INSERT INTO sandbox_generations (branch_id, generation, person_id, kind, instance, billing_mode, started_at, seen_at)
            VALUES (${"branch-paid-1"}, 1, ${contributorId}::uuid, ${"branch"}, ${"standard-1"}, ${"paid"}, now() - interval '120 seconds', now())`
          const seenOutcome = yield* Budget.seen("branch-paid-1", 1)
          const expectedMin = chargeMicroUsd("standard-1", 120, 2)
          expect(seenOutcome.paid).toBe(true)
          expect(seenOutcome.chargedMicroUsd).toBeGreaterThanOrEqual(expectedMin)
          expect(seenOutcome.exhausted).toBe(false)
          expect(seenOutcome.balanceMicroUsd).toBe(10 * MICRO_USD_PER_USD - seenOutcome.chargedMicroUsd)

          // 5. Hard cap at $0: set balance to 100 micro-USD and run a 300s paid sandbox -> drains to 0 and flags exhausted!
          yield* sql`UPDATE compute_accounts SET balance_micro_usd = 100 WHERE person_id = ${contributorId}::uuid`
          yield* sql`
            INSERT INTO sandbox_generations (branch_id, generation, person_id, kind, instance, billing_mode, started_at, seen_at)
            VALUES (${"branch-paid-exhaust"}, 1, ${contributorId}::uuid, ${"branch"}, ${"standard-1"}, ${"paid"}, now() - interval '300 seconds', now())`
          const exhaustOutcome = yield* Budget.seen("branch-paid-exhaust", 1)
          expect(exhaustOutcome.paid).toBe(true)
          expect(exhaustOutcome.chargedMicroUsd).toBe(100)
          expect(exhaustOutcome.balanceMicroUsd).toBe(0)
          expect(exhaustOutcome.exhausted).toBe(true)

          // 6. At $0 balance, Budget.admit refuses paid slot and ComputeAccess denies!
          const admitZero = yield* Budget.admit({ branchId: "branch-paid-zero", personId: contributorId, kind: "branch", billingMode: "paid" })
          expect(admitZero._tag).toBe("Waiting")
          expect(yield* ComputeAccess.canRunMachine(contributor)).toBe(false)

          // 7. HTTP BillingApi tests: account, checkout (person-only + stripe), webhook -> FlowStarter, admin grant.
          const startedFlows: Array<{ flow: unknown; payload: unknown }> = []
          const fakeStarter = Layer.succeed(
            Flows.FlowStarter,
            Flows.FlowStarter.of({
              start: (flow, options) => {
                startedFlows.push({ flow, payload: options.payload })
                return Effect.void
              },
            }),
          )
          const sharedDb = Layer.succeed(SqlClient.SqlClient, sql)
          const api = yield* BillingApi.make(sharedDb)
          const handler = (actor: Actor | undefined, providerLayer = stripeLayer) =>
            HttpEffect.toWebHandler(
              api.fetch.pipe(
                Effect.provide(sessionOf(actor)),
                Effect.provide(providerLayer),
                Effect.provide(fakeStarter),
              ),
            )

          // Signed out -> 401
          const r401 = yield* Effect.promise(() =>
            handler(undefined)(new Request(`https://smithers.sh${BILLING_ACCOUNT_ROUTE}`)),
          )
          expect(r401.status).toBe(401)

          // Signed in -> 200 with account state & ledger
          const rAcct = yield* Effect.promise(() =>
            handler(contributor)(new Request(`https://smithers.sh${BILLING_ACCOUNT_ROUTE}`)),
          )
          expect(rAcct.status).toBe(200)
          const acctJson = (yield* Effect.promise(() => rAcct.json())) as Record<string, unknown>
          expect(acctJson.balanceMicroUsd).toBe(0)
          expect(acctJson.stripeConfigured).toBe(true)
          expect(Array.isArray(acctJson.ledger)).toBe(true)

          // Checkout person-only refusal when agent acts
          const delegated: Actor = { ...contributor, act: { kind: "agent", id: "run-1" } }
          const rPersonOnly = yield* Effect.promise(() =>
            handler(delegated)(
              new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ packId: "pack_10" }),
              }),
            ),
          )
          expect(rPersonOnly.status).toBe(403)

          // Checkout disabled when Stripe unset -> 503 not_configured
          const rDisabled = yield* Effect.promise(() =>
            handler(contributor, disabledLayer)(
              new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ packId: "pack_10" }),
              }),
            ),
          )
          expect(rDisabled.status).toBe(503)

          // Checkout success -> 200 { url, sessionId }
          const rCheckout = yield* Effect.promise(() =>
            handler(contributor)(
              new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, {
                method: "POST",
                headers: { "content-type": "application/json", origin: "https://smithers.sh" },
                body: JSON.stringify({ packId: "pack_25" }),
              }),
            ),
          )
          expect(rCheckout.status).toBe(200)
          const checkoutJson = (yield* Effect.promise(() => rCheckout.json())) as { sessionId: string; url: string }
          expect(checkoutJson.sessionId).toBe("cs_live_1")

          // Webhook verified -> starts billing/CreditTopUp flow
          const ts = Math.floor(Date.now() / 1000)
          const webhookBody = JSON.stringify({
            id: "evt_live_topup",
            type: "checkout.session.completed",
            data: {
              object: {
                id: "cs_live_1",
                payment_status: "paid",
                customer: "cus_live_1",
                metadata: { person_id: contributorId, pack_id: "pack_25" },
              },
            },
          })
          const sig = yield* Effect.promise(() => computeStripeHmacHex(webhookSecret, ts, webhookBody))
          const rWebhook = yield* Effect.promise(() =>
            handler(undefined)(
              new Request(`https://smithers.sh${BILLING_WEBHOOK_ROUTE}`, {
                method: "POST",
                headers: { "stripe-signature": `t=${ts},v1=${sig}`, "content-type": "application/json" },
                body: webhookBody,
              }),
            ),
          )
          expect(rWebhook.status).toBe(200)
          expect(startedFlows.some((f) => f.flow === BillingFlows.CreditTopUp)).toBe(true)

          // Admin grant: non-admin refused 403, admin accepted 202 and starts billing/AdminGrant
          const rGrantForbidden = yield* Effect.promise(() =>
            handler(contributor)(
              new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ login: "contrib-alice", amountUsd: 10 }),
              }),
            ),
          )
          expect(rGrantForbidden.status).toBe(403)

          const rGrantOk = yield* Effect.promise(() =>
            handler(member)(
              new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ login: "contrib-alice", amountUsd: 15, note: "Welcome" }),
              }),
            ),
          )
          expect(rGrantOk.status).toBe(202)
          expect(startedFlows.some((f) => f.flow === BillingFlows.AdminGrant)).toBe(true)

          // Execute the real durable billing/CreditTopUp flow on the Node flow host
          const ran = yield* Effect.promise(() =>
            runFlow(
              BillingFlows.CreditTopUp,
              {
                eventId: "evt_live_topup",
                sessionId: "cs_live_1",
                personId: contributorId,
                packId: "pack_25",
                amountMicroUsd: 25 * MICRO_USD_PER_USD,
                customerId: "cus_live_1",
              },
              BillingFlows.registration(sharedDb),
            ),
          )
          expect(ran.exit._tag).toBe("Success")
          if (ran.exit._tag === "Success") {
            expect(ran.exit.value).toEqual({ applied: true, balanceMicroUsd: 25 * MICRO_USD_PER_USD })
          }
          expect(yield* BillingStore.balanceOf(contributorId)).toBe(25 * MICRO_USD_PER_USD)
          expect(MIN_ADMIT_MICRO_USD).toBe(50_000)
        }),
      ).pipe(Effect.provide(dbLayer)),
    )
  })
})
