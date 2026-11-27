import { ConfigProvider, Effect, Exit, Layer, Option, Redacted } from "effect"
import { HttpEffect } from "effect/http"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import {
  BILLING_ACCOUNT_ROUTE,
  BILLING_ADMIN_GRANT_ROUTE,
  BILLING_CHECKOUT_ROUTE,
  BILLING_ROUTE,
  BILLING_WEBHOOK_ROUTE,
  chargeMicroUsd,
  MICRO_USD_PER_USD,
  MIN_ADMIT_MICRO_USD,
} from "../../src/features/billing/contract.ts"
import { type Actor, Sessions } from "../Actor.vibe"
import * as Budget from "../branch/Budget.vibe"
import * as Flows from "../Flows.vibe"
import { runFlow } from "../test/flowHost.ts"
import * as BillingApi from "./BillingApi.vibe"
import * as BillingFlows from "./BillingFlows.vibe"
import { BillingProvider, BillingProviderError, disabledLayer } from "./BillingProvider.ts"
import * as BillingStore from "./BillingStore.vibe"
import * as ComputeAccess from "./ComputeAccess.vibe"
import { computeStripeHmacHex, parseStripeSignature, randomUuid, timingSafeEqualHex } from "./StripeCrypto.ts"
import * as StripeProvider from "./StripeProvider.vibe"

const sessionOf = (actor: Actor | undefined) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      resolve: Effect.succeed(actor === undefined ? Option.none() : Option.some(actor)),
    }),
  )

const brokenSqlLayer = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("db down")))

const seedPerson = (sql: SqlClient.SqlClient, githubId: number, login: string) => {
  const id = crypto.randomUUID()
  return sql<{ readonly id: string }>`
    INSERT INTO people (id, github_id, github_login)
    VALUES (${id}::uuid, ${githubId}, ${login})
    RETURNING id::text AS id`.pipe(Effect.map((rows) => rows[0]!.id))
}

describe("StripeCrypto & BillingProvider disabledLayer", () => {
  test("parses valid Stripe-Signature headers, ignores unknown/malformed parts, and verifies HMAC", async () => {
    const secret = "whsec_test_secret_12345"
    const ts = Math.floor(Date.now() / 1000)
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" })
    const sig = await computeStripeHmacHex(secret, ts, body)
    expect(parseStripeSignature(`t=${ts},v1=${sig},v0=ignored,badpart,v1=short`)).toEqual({
      timestamp: ts,
      signatures: [sig],
    })
    expect(timingSafeEqualHex(sig, sig)).toBe(true)
    expect(timingSafeEqualHex(sig, "0".repeat(64))).toBe(false)
    expect(timingSafeEqualHex("abc", "abcd")).toBe(false)
    expect(parseStripeSignature("invalid")).toBeUndefined()
    expect(parseStripeSignature(`t=${ts}`)).toBeUndefined()
    expect(parseStripeSignature(`v1=${sig}`)).toBeUndefined()
    expect(parseStripeSignature("t=notanumber,v1=" + sig)).toBeUndefined()
    expect(randomUuid()).toMatch(/^[0-9a-f-]{36}$/i)
  })

  test("disabledLayer fails both checkout and webhook with not_configured", async () => {
    const checkoutExit = await Effect.runPromiseExit(
      Effect.flatMap(BillingProvider, (p) =>
        p.createCheckoutSession({
          personId: "11111111-1111-1111-1111-111111111111",
          login: "alice",
          packId: "pack_10",
          packLabel: "$10",
          amountCents: 1000,
          amountMicroUsd: 10 * MICRO_USD_PER_USD,
          successUrl: "https://smithers.sh/ok",
          cancelUrl: "https://smithers.sh/no",
        }),
      ).pipe(Effect.provide(disabledLayer)),
    )
    expect(Exit.isFailure(checkoutExit)).toBe(true)
    const webhookExit = await Effect.runPromiseExit(
      Effect.flatMap(BillingProvider, (p) => p.verifyWebhook("{}", "t=1,v1=" + "0".repeat(64))).pipe(
        Effect.provide(disabledLayer),
      ),
    )
    expect(Exit.isFailure(webhookExit)).toBe(true)
  })
})

describe("StripeProvider", () => {
  test("configFromEnv and layerFromEnv resolve configured and unconfigured environments", async () => {
    const empty = await Effect.runPromise(
      StripeProvider.configFromEnv.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      ),
    )
    expect(Option.isNone(empty)).toBe(true)

    const blank = await Effect.runPromise(
      StripeProvider.configFromEnv.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ STRIPE_SECRET_KEY: "   " })),
      ),
    )
    expect(Option.isNone(blank)).toBe(true)

    const configured = await Effect.runPromise(
      StripeProvider.configFromEnv.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            STRIPE_SECRET_KEY: "sk_test_1",
            STRIPE_WEBHOOK_SECRET: "whsec_1",
            STRIPE_API_URL: "https://api.stripe.test///",
          }),
        ),
      ),
    )
    expect(Option.isSome(configured)).toBe(true)
    expect(Option.getOrThrow(configured).apiUrl).toBe("https://api.stripe.test")

    const uncfgProv = await Effect.runPromise(
      BillingProvider.pipe(
        Effect.provide(StripeProvider.layerFromEnv()),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      ),
    )
    expect(uncfgProv.configured).toBe(false)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          uncfgProv.createCheckoutSession({
            personId: "11111111-1111-1111-1111-111111111111",
            login: "a",
            packId: "pack_10",
            packLabel: "$10",
            amountCents: 1000,
            amountMicroUsd: 10 * MICRO_USD_PER_USD,
            successUrl: "https://a",
            cancelUrl: "https://b",
          }),
        ),
      ),
    ).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(uncfgProv.verifyWebhook("{}", "sig")))).toBe(true)

    const cfgProv = await Effect.runPromise(
      BillingProvider.pipe(
        Effect.provide(StripeProvider.layerFromEnv()),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ STRIPE_SECRET_KEY: "sk_test_1" }),
        ),
      ),
    )
    expect(cfgProv.configured).toBe(true)
  })

  test("creates a Checkout session, verifies signed webhooks, and rejects invalid/replayed/malformed inputs", async () => {
    const secret = "whsec_provider_test_secret"
    let httpMode: "ok" | "500" | "net" | "badjson" | "missingfields" = "ok"
    let seenUrl = ""
    let seenAuth = ""
    let seenBody = ""
    const fakeHttp = HttpClient.make((req) => {
      seenUrl = req.url
      seenAuth = req.headers.authorization ?? ""
      seenBody = req.body._tag === "Uint8Array" ? new TextDecoder().decode(req.body.body) : ""
      if (httpMode === "net") {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: req, cause: new Error("down") }),
          }),
        )
      }
      if (httpMode === "500") {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("err", { status: 500 })))
      }
      if (httpMode === "badjson") {
        return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("not-json", { status: 200 })))
      }
      if (httpMode === "missingfields") {
        return Effect.succeed(
          HttpClientResponse.fromWeb(req, new Response(JSON.stringify({ id: "" }), { status: 200 })),
        )
      }
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

    const checkoutReq = {
      personId: "11111111-1111-1111-1111-111111111111",
      login: "alice",
      packId: "pack_10" as const,
      packLabel: "$10",
      amountCents: 1000,
      amountMicroUsd: 10 * MICRO_USD_PER_USD,
      successUrl: "https://smithers.sh/app/settings?billing=success",
      cancelUrl: "https://smithers.sh/app/settings?billing=canceled",
    }

    const layer = StripeProvider.make(
      {
        secretKey: Redacted.make("sk_test_key"),
        webhookSecret: Option.some(Redacted.make(secret)),
        apiUrl: "https://api.stripe.test",
      },
      fakeHttp,
    )

    const nowSec = Math.floor(Date.now() / 1000)
    const sign = (body: string, ts = nowSec) =>
      Effect.promise(() => computeStripeHmacHex(secret, ts, body)).pipe(Effect.map((h) => `t=${ts},v1=${h}`))

    await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* BillingProvider
        expect(provider.configured).toBe(true)

        // Checkout happy path
        const session = yield* provider.createCheckoutSession(checkoutReq)
        expect(seenUrl).toBe("https://api.stripe.test/v1/checkout/sessions")
        expect(seenAuth).toBe("Bearer sk_test_key")
        expect(seenBody).toContain("unit_amount%5D=1000")
        expect(session).toEqual({ sessionId: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" })

        // Checkout error paths
        for (const mode of ["500", "net", "badjson", "missingfields"] as const) {
          httpMode = mode
          const res = yield* Effect.result(provider.createCheckoutSession(checkoutReq))
          expect(res._tag).toBe("Failure")
        }
        httpMode = "ok"

        // Valid checkout.session.completed webhook (with & without customer)
        const payload = JSON.stringify({
          id: "evt_topup_1",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_123",
              payment_status: "paid",
              customer: "cus_abc",
              metadata: { person_id: "11111111-1111-1111-1111-111111111111", pack_id: "pack_10" },
            },
          },
        })
        const verified = yield* provider.verifyWebhook(payload, yield* sign(payload))
        expect(verified).toMatchObject({
          kind: "checkout.completed",
          eventId: "evt_topup_1",
          sessionId: "cs_test_123",
          packId: "pack_10",
          amountMicroUsd: 10 * MICRO_USD_PER_USD,
          customerId: "cus_abc",
        })

        // Bad signature format, expired timestamp, wrong HMAC
        expect((yield* Effect.result(provider.verifyWebhook(payload, "garbage")))._tag).toBe("Failure")
        expect((yield* Effect.result(provider.verifyWebhook(payload, yield* sign(payload, nowSec - 600))))._tag).toBe(
          "Failure",
        )
        expect((yield* Effect.result(provider.verifyWebhook(payload, `t=${nowSec},v1=${"0".repeat(64)}`)))._tag).toBe(
          "Failure",
        )

        // Invalid JSON body
        const badJson = "{not json"
        expect((yield* Effect.result(provider.verifyWebhook(badJson, yield* sign(badJson))))._tag).toBe("Failure")

        // Missing event id/type
        const noId = JSON.stringify({ foo: 1 })
        expect((yield* Effect.result(provider.verifyWebhook(noId, yield* sign(noId))))._tag).toBe("Failure")

        // Ignored event type
        const ignored = JSON.stringify({ id: "evt_2", type: "customer.created", data: { object: {} } })
        expect(yield* provider.verifyWebhook(ignored, yield* sign(ignored))).toEqual({
          kind: "ignored",
          eventId: "evt_2",
          type: "customer.created",
        })

        // Unpaid checkout session -> ignored
        const unpaid = JSON.stringify({
          id: "evt_3",
          type: "checkout.session.completed",
          data: { object: { id: "cs_unpaid", payment_status: "unpaid" } },
        })
        expect(yield* provider.verifyWebhook(unpaid, yield* sign(unpaid))).toEqual({
          kind: "ignored",
          eventId: "evt_3",
          type: "checkout.session.completed:unpaid",
        })

        // Missing data object / missing metadata / unknown pack -> invalid_payload
        const noDataObj = JSON.stringify({ id: "evt_4", type: "checkout.session.completed", data: {} })
        expect((yield* Effect.result(provider.verifyWebhook(noDataObj, yield* sign(noDataObj))))._tag).toBe("Failure")
        const missingMeta = JSON.stringify({
          id: "evt_5",
          type: "checkout.session.completed",
          data: { object: { id: "cs_x", payment_status: "paid", metadata: {} } },
        })
        expect((yield* Effect.result(provider.verifyWebhook(missingMeta, yield* sign(missingMeta))))._tag).toBe(
          "Failure",
        )
        const badPack = JSON.stringify({
          id: "evt_6",
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_x",
              payment_status: "paid",
              metadata: { person_id: "11111111-1111-1111-1111-111111111111", pack_id: "pack_999" },
            },
          },
        })
        expect((yield* Effect.result(provider.verifyWebhook(badPack, yield* sign(badPack))))._tag).toBe("Failure")
      }).pipe(Effect.provide(layer)),
    )

    // Missing webhookSecret rejects webhook with not_configured
    const noSecretLayer = StripeProvider.make(
      {
        secretKey: Redacted.make("sk_test_key"),
        webhookSecret: Option.none(),
        apiUrl: "https://api.stripe.test",
      },
      fakeHttp,
    )
    const noSecRes = await Effect.runPromise(
      Effect.flatMap(BillingProvider, (p) => p.verifyWebhook("{}", "t=1,v1=" + "0".repeat(64))).pipe(
        Effect.provide(noSecretLayer),
        Effect.result,
      ),
    )
    expect(noSecRes._tag).toBe("Failure")
  })
})

describe("BillingStore, ComputeAccess, Budget settlement, and BillingFlows", () => {
  test("configuredMultiplier handles valid, invalid, and unset values", async () => {
    expect(
      await Effect.runPromise(
        BillingStore.configuredMultiplier.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
        ),
      ),
    ).toBe(2)
    expect(
      await Effect.runPromise(
        BillingStore.configuredMultiplier.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ COMPUTE_PRICE_MULTIPLIER: "3.5" }),
          ),
        ),
      ),
    ).toBe(3.5)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          BillingStore.configuredMultiplier.pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ COMPUTE_PRICE_MULTIPLIER: "not-a-number" }),
            ),
          ),
        ),
      ),
    ).toBe(true)
    expect(
      await Effect.runPromise(
        BillingStore.configuredMultiplier.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ COMPUTE_PRICE_MULTIPLIER: "-1" }),
          ),
        ),
      ),
    ).toBe(2)
  })

  test("idempotent top-ups, admin grants, paid sandbox metering, ComputeAccess, and BillingFlows", async () => {
    const dbLayer = TestDatabase.layer("billing-store-full")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sharedDb = Layer.succeed(SqlClient.SqlClient, sql)
          const personId = yield* seedPerson(sql, 77001, "contrib-alice")
          const memberId = yield* seedPerson(sql, 77002, "maint-bob")
          const guestActor: Actor = { subject: { kind: "person", id: personId }, role: null, login: "contrib-alice" }
          const memberActor: Actor = { subject: { kind: "person", id: memberId }, role: "member", login: "maint-bob" }

          // Non-UUID personId returns 0 cleanly
          expect(yield* BillingStore.balanceOf("not-a-uuid")).toBe(0)
          expect(Option.isNone(yield* BillingStore.findPersonByLogin("nobody-here"))).toBe(true)
          expect(Option.getOrUndefined(yield* BillingStore.findPersonByLogin("contrib-alice"))).toEqual({
            id: personId,
            login: "contrib-alice",
          })

          // ComputeAccess: member (deployment), unpaid guest (none), sessionSummary
          expect(yield* ComputeAccess.check(memberActor)).toEqual({
            allowed: true,
            mode: "deployment",
            billingMode: "deployment",
            balanceMicroUsd: 0,
          })
          expect(yield* ComputeAccess.check(guestActor)).toEqual({
            allowed: false,
            mode: "none",
            billingMode: "paid",
            balanceMicroUsd: 0,
          })
          expect(yield* ComputeAccess.sessionSummary(memberActor)).toEqual({
            computeAccess: "deployment",
            computeBalanceMicroUsd: 0,
          })
          expect(yield* ComputeAccess.sessionSummary(guestActor)).toEqual({
            computeAccess: "none",
            computeBalanceMicroUsd: 0,
          })
          expect(yield* ComputeAccess.canRunMachine(memberActor)).toBe(true)
          expect(yield* ComputeAccess.canRunMachine(guestActor)).toBe(false)

          // Unpaid contributor is denied admission by ComputeAccess; member is deployment-funded
          expect(yield* ComputeAccess.canRunMachine(guestActor)).toBe(false)
          expect(yield* ComputeAccess.canRunMachine(memberActor)).toBe(true)

          // Record checkout pending & top up via durable CreditTopUp flow (runs twice -> idempotent)
          yield* BillingStore.recordCheckoutPending({
            sessionId: "cs_flow_1",
            personId,
            packId: "pack_10",
            amountMicroUsd: 10 * MICRO_USD_PER_USD,
          })
          expect(BillingFlows.topUpExecutionId("evt_1")).toBe("billing-topup:evt_1")
          expect(BillingFlows.grantExecutionId("g_1")).toBe("billing-grant:g_1")

          const topUp1 = yield* Effect.promise(() =>
            runFlow(
              BillingFlows.CreditTopUp,
              {
                eventId: "evt_flow_1",
                sessionId: "cs_flow_1",
                personId,
                packId: "pack_10",
                amountMicroUsd: 10 * MICRO_USD_PER_USD,
                customerId: "cus_alice",
              },
              BillingFlows.registration(sharedDb),
            ),
          )
          expect(topUp1.exit).toEqual(Exit.succeed({ applied: true, balanceMicroUsd: 10 * MICRO_USD_PER_USD }))

          const topUp2 = yield* Effect.promise(() =>
            runFlow(
              BillingFlows.CreditTopUp,
              {
                eventId: "evt_flow_1",
                sessionId: "cs_flow_1",
                personId,
                packId: "pack_10",
                amountMicroUsd: 10 * MICRO_USD_PER_USD,
                customerId: null,
              },
              BillingFlows.registration(sharedDb),
            ),
          )
          expect(topUp2.exit).toEqual(Exit.succeed({ applied: false, balanceMicroUsd: 10 * MICRO_USD_PER_USD }))

          // AdminGrant durable flow (with note and with empty note)
          const grant1 = yield* Effect.promise(() =>
            runFlow(
              BillingFlows.AdminGrant,
              {
                grantId: "grant_1",
                personId,
                grantedByLogin: "maint-bob",
                amountMicroUsd: 5 * MICRO_USD_PER_USD,
                note: "OSS contributor",
              },
              BillingFlows.registration(sharedDb),
            ),
          )
          expect(grant1.exit).toEqual(Exit.succeed({ applied: true, balanceMicroUsd: 15 * MICRO_USD_PER_USD }))

          const grant2 = yield* Effect.promise(() =>
            runFlow(
              BillingFlows.AdminGrant,
              {
                grantId: "grant_2",
                personId,
                grantedByLogin: "maint-bob",
                amountMicroUsd: 1 * MICRO_USD_PER_USD,
                note: "",
              },
              BillingFlows.registration(sharedDb),
            ),
          )
          expect(grant2.exit).toEqual(Exit.succeed({ applied: true, balanceMicroUsd: 16 * MICRO_USD_PER_USD }))

          // Now ComputeAccess admits guestActor as paid
          expect(yield* ComputeAccess.check(guestActor)).toEqual({
            allowed: true,
            mode: "paid",
            billingMode: "paid",
            balanceMicroUsd: 16 * MICRO_USD_PER_USD,
          })
          expect(yield* ComputeAccess.sessionSummary(guestActor)).toEqual({
            computeAccess: "paid",
            computeBalanceMicroUsd: 16 * MICRO_USD_PER_USD,
          })
          expect(yield* ComputeAccess.canRunMachine(guestActor)).toBe(true)

          // Account state for both paid contributor and deployment member
          const paidAcct = yield* BillingStore.accountState({
            personId,
            isDeploymentMember: false,
            stripeConfigured: true,
            multiplier: 2,
            defaultInstance: "standard-1",
          })
          expect(paidAcct.computeAccess).toBe("paid")
          expect(paidAcct.balanceMicroUsd).toBe(16 * MICRO_USD_PER_USD)
          expect(paidAcct.ledger.length).toBe(3)

          const memberAcct = yield* BillingStore.accountState({
            personId: memberId,
            isDeploymentMember: true,
            stripeConfigured: false,
            multiplier: 2,
            defaultInstance: "standard-1",
          })
          expect(memberAcct.computeAccess).toBe("deployment")

          // Sandbox generation settlement edge cases:
          // 1. Missing generation -> paid: false
          expect(yield* BillingStore.settleGeneration("branch-missing", 1, 2)).toEqual({
            paid: false,
            chargedMicroUsd: 0,
            balanceMicroUsd: 0,
            exhausted: false,
          })
          // 2. Deployment generation -> paid: false
          yield* sql`
            INSERT INTO sandbox_generations (branch_id, generation, kind, started_at, seen_at, person_id, instance, billing_mode)
            VALUES (${"branch-dep"}, 1, 'branch', now() - interval '60 seconds', now(), ${memberId}::uuid, ${"standard-1"}, ${"deployment"})`
          expect(yield* BillingStore.settleGeneration("branch-dep", 1, 2)).toEqual({
            paid: false,
            chargedMicroUsd: 0,
            balanceMicroUsd: 0,
            exhausted: false,
          })
          // 3. Paid generation with 0 elapsed seconds -> deltaSeconds === 0
          yield* sql`
            INSERT INTO sandbox_generations (branch_id, generation, kind, started_at, seen_at, person_id, instance, billing_mode)
            VALUES (${"branch-zero"}, 1, 'branch', now(), now(), ${personId}::uuid, ${"standard-1"}, ${"paid"})`
          const zeroSettle = yield* BillingStore.settleGeneration("branch-zero", 1, 2)
          expect(zeroSettle).toMatchObject({ paid: true, chargedMicroUsd: 0, exhausted: false })

          // 4. Paid generation with 60s elapsed -> charges ~2468 micro-USD
          yield* sql`
            INSERT INTO sandbox_generations (branch_id, generation, kind, started_at, seen_at, person_id, instance, billing_mode)
            VALUES (${"branch-paid"}, 1, 'branch', now() - interval '60 seconds', now(), ${personId}::uuid, ${"standard-1"}, ${"paid"})`
          const charged = yield* Budget.seen("branch-paid", 1)
          expect(charged.paid).toBe(true)
          expect(charged.chargedMicroUsd).toBeGreaterThanOrEqual(chargeMicroUsd("standard-1", 60, 2))
          expect(charged.exhausted).toBe(false)

          // 5. Exhaustion clamps balance at 0 and flags exhausted: true
          yield* sql`UPDATE compute_accounts SET balance_micro_usd = 100 WHERE person_id = ${personId}::uuid`
          yield* sql`
            UPDATE sandbox_generations
            SET started_at = now() - interval '300 seconds', billed_seconds = 60
            WHERE branch_id = ${"branch-paid"} AND generation = 1`
          const ended = yield* Budget.ended("branch-paid", 1)
          expect(ended).toEqual({ paid: true, chargedMicroUsd: 100, balanceMicroUsd: 0, exhausted: true })

          // 6. Account below MIN_ADMIT_MICRO_USD reports computeAccess: "none"
          const emptyAcct = yield* BillingStore.accountState({
            personId,
            isDeploymentMember: false,
            stripeConfigured: true,
            multiplier: 2,
            defaultInstance: "standard-1",
          })
          expect(emptyAcct.computeAccess).toBe("none")
          expect(emptyAcct.balanceMicroUsd).toBe(0)
          expect(MIN_ADMIT_MICRO_USD).toBe(50_000)

          // 7. BillingFlows error path maps DB failures to BillingStoreUnavailable
          const brokenSteps = BillingFlows.steps(brokenSqlLayer)
          const failedTopUp = yield* Effect.result(
            brokenSteps.applyTopUp({
              eventId: "evt_fail",
              sessionId: "cs_fail",
              personId,
              packId: "pack_10",
              amountMicroUsd: 10 * MICRO_USD_PER_USD,
              customerId: null,
            }),
          )
          expect(failedTopUp._tag).toBe("Failure")

          const failedGrant = yield* Effect.result(
            brokenSteps.applyGrant({
              grantId: "g_fail",
              personId,
              grantedByLogin: "maint-bob",
              amountMicroUsd: 1 * MICRO_USD_PER_USD,
              note: "test",
            }),
          )
          expect(failedGrant._tag).toBe("Failure")
        }),
      ).pipe(Effect.provide(dbLayer)),
    )
  }, 60_000)
})

describe("BillingApi routes", () => {
  test("covers all routes, methods, auth, validation, origin detection, webhook outcomes, and error paths", async () => {
    const dbLayer = TestDatabase.layer("billing-api-full")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sharedDb = Layer.succeed(SqlClient.SqlClient, sql)
          const personId = yield* seedPerson(sql, 78001, "contrib-sam")
          const adminId = yield* seedPerson(sql, 78002, "admin-will")
          const contribActor: Actor = { subject: { kind: "person", id: personId }, role: null, login: "contrib-sam" }
          const adminActor: Actor = { subject: { kind: "person", id: adminId }, role: "admin", login: "admin-will" }
          const agentAdmin: Actor = { ...adminActor, act: { kind: "agent", id: "run-1" } }
          const agentContrib: Actor = { ...contribActor, act: { kind: "agent", id: "run-2" } }

          const webhookSecret = "whsec_api_full_test"
          let stripeFail = false
          const fakeHttp = HttpClient.make((req) => {
            if (stripeFail) {
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("boom", { status: 500 })))
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(JSON.stringify({ id: "cs_api_1", url: "https://checkout.stripe.com/c/pay/cs_api_1" }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            )
          })
          const providerLayer = StripeProvider.make(
            {
              secretKey: Redacted.make("sk_test_api"),
              webhookSecret: Option.some(Redacted.make(webhookSecret)),
              apiUrl: "https://api.stripe.test",
            },
            fakeHttp,
          )

          let starterMode: "ok" | "conflict" | "unavailable" = "ok"
          const started: Array<{ flow: unknown; payload: unknown }> = []
          const starterLayer = Layer.succeed(
            Flows.FlowStarter,
            Flows.FlowStarter.of({
              start: (flow, options) => {
                if (starterMode === "conflict") return Effect.fail(new Flows.StartConflict())
                if (starterMode === "unavailable") return Effect.fail(new Flows.StartUnavailable({ errorCode: "down" }))
                started.push({ flow, payload: options.payload })
                return Effect.void
              },
            }),
          )

          const api = yield* BillingApi.make(sharedDb)
          const brokenApi = yield* BillingApi.make(brokenSqlLayer)

          const call = (
            who: Actor | undefined,
            req: Request,
            opts: { provider?: Layer.Layer<BillingProvider>; useBrokenDb?: boolean } = {},
          ) =>
            Effect.promise(() =>
              HttpEffect.toWebHandler(
                (opts.useBrokenDb ? brokenApi : api).fetch.pipe(
                  Effect.provide(sessionOf(who)),
                  Effect.provide(opts.provider ?? providerLayer),
                  Effect.provide(starterLayer),
                ),
              )(req),
            )

          expect(BillingApi.handles(BILLING_ROUTE)).toBe(true)
          expect(BillingApi.handles(BILLING_ACCOUNT_ROUTE)).toBe(true)
          expect(BillingApi.handles(BILLING_CHECKOUT_ROUTE)).toBe(true)
          expect(BillingApi.handles(BILLING_WEBHOOK_ROUTE)).toBe(true)
          expect(BillingApi.handles(BILLING_ADMIN_GRANT_ROUTE)).toBe(true)
          expect(BillingApi.handles("/api/other")).toBe(false)

          // Unknown billing root -> 404
          expect((yield* call(contribActor, new Request(`https://smithers.sh${BILLING_ROUTE}`))).status).toBe(404)

          // Account: 405, 401, 200, 503
          expect(
            (yield* call(contribActor, new Request(`https://smithers.sh${BILLING_ACCOUNT_ROUTE}`, { method: "POST" })))
              .status,
          ).toBe(405)
          expect((yield* call(undefined, new Request(`https://smithers.sh${BILLING_ACCOUNT_ROUTE}`))).status).toBe(401)
          expect(
            (yield* call(contribActor, new Request(`https://smithers.sh${BILLING_ACCOUNT_ROUTE}`))).status,
          ).toBe(200)
          expect(
            (
              yield* call(contribActor, new Request(`https://smithers.sh${BILLING_ACCOUNT_ROUTE}`), {
                useBrokenDb: true,
              })
            ).status,
          ).toBe(503)

          // Checkout: 405, 401, 403 agent, 503 disabled provider, 413 too large, 400 bad body, 502 upstream, 200 ok (origin, host+http, fallback)
          expect((yield* call(contribActor, new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`))).status).toBe(
            405,
          )
          expect(
            (yield* call(undefined, new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, { method: "POST" })))
              .status,
          ).toBe(401)
          expect(
            (
              yield* call(
                agentContrib,
                new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, {
                  method: "POST",
                  body: JSON.stringify({ packId: "pack_10" }),
                }),
              )
            ).status,
          ).toBe(403)
          expect(
            (
              yield* call(
                contribActor,
                new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, {
                  method: "POST",
                  body: JSON.stringify({ packId: "pack_10" }),
                }),
                { provider: disabledLayer },
              )
            ).status,
          ).toBe(503)
          expect(
            (
              yield* call(
                contribActor,
                new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, {
                  method: "POST",
                  body: "x".repeat(20_000),
                }),
              )
            ).status,
          ).toBe(413)
          expect(
            (
              yield* call(
                contribActor,
                new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, {
                  method: "POST",
                  body: JSON.stringify({ packId: "pack_nope" }),
                }),
              )
            ).status,
          ).toBe(400)

          stripeFail = true
          expect(
            (
              yield* call(
                contribActor,
                new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, {
                  method: "POST",
                  body: JSON.stringify({ packId: "pack_10" }),
                }),
              )
            ).status,
          ).toBe(502)
          stripeFail = false

          // Origin header, host+x-forwarded-proto, and fallback origin
          for (const headers of [
            { origin: "https://custom.smithers.sh" },
            { host: "localhost:1337", "x-forwarded-proto": "http" },
            { host: "smithers.sh" },
            {},
          ] as ReadonlyArray<Record<string, string>>) {
            const okRes = yield* call(
              contribActor,
              new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify({ packId: "pack_10" }),
              }),
            )
            expect(okRes.status).toBe(200)
          }

          // Provider returns not_configured error during createCheckoutSession -> 503
          const notCfgErrProvider = Layer.succeed(
            BillingProvider,
            BillingProvider.of({
              configured: true,
              createCheckoutSession: () => Effect.fail(new BillingProviderError({ code: "not_configured" })),
              verifyWebhook: () => Effect.fail({ _tag: "@smthrs/mvp/billing/BillingWebhookError", code: "not_configured" } as never),
            }),
          )
          expect(
            (
              yield* call(
                contribActor,
                new Request(`https://smithers.sh${BILLING_CHECKOUT_ROUTE}`, {
                  method: "POST",
                  body: JSON.stringify({ packId: "pack_10" }),
                }),
                { provider: notCfgErrProvider },
              )
            ).status,
          ).toBe(503)

          // Webhook: 405, 503 disabled, 413 too large, 400 missing/bad sig, 200 ignored, 202 accepted, 200 conflict, 503 unavailable
          expect((yield* call(undefined, new Request(`https://smithers.sh${BILLING_WEBHOOK_ROUTE}`))).status).toBe(405)
          expect(
            (
              yield* call(undefined, new Request(`https://smithers.sh${BILLING_WEBHOOK_ROUTE}`, { method: "POST" }), {
                provider: disabledLayer,
              })
            ).status,
          ).toBe(503)
          expect(
            (
              yield* call(
                undefined,
                new Request(`https://smithers.sh${BILLING_WEBHOOK_ROUTE}`, {
                  method: "POST",
                  headers: { "stripe-signature": "t=1,v1=" + "0".repeat(64) },
                  body: "x".repeat(300_000),
                }),
              )
            ).status,
          ).toBe(413)
          expect(
            (
              yield* call(
                undefined,
                new Request(`https://smithers.sh${BILLING_WEBHOOK_ROUTE}`, {
                  method: "POST",
                  body: "{}",
                }),
              )
            ).status,
          ).toBe(400)
          expect(
            (
              yield* call(
                undefined,
                new Request(`https://smithers.sh${BILLING_WEBHOOK_ROUTE}`, {
                  method: "POST",
                  headers: { "stripe-signature": "bad" },
                  body: "{}",
                }),
              )
            ).status,
          ).toBe(400)

          const ts = Math.floor(Date.now() / 1000)
          const signBody = (body: string) =>
            Effect.promise(() => computeStripeHmacHex(webhookSecret, ts, body)).pipe(Effect.map((h) => `t=${ts},v1=${h}`))

          const ignoredBody = JSON.stringify({ id: "evt_ign", type: "ping", data: { object: {} } })
          expect(
            (
              yield* call(
                undefined,
                new Request(`https://smithers.sh${BILLING_WEBHOOK_ROUTE}`, {
                  method: "POST",
                  headers: { "stripe-signature": yield* signBody(ignoredBody) },
                  body: ignoredBody,
                }),
              )
            ).status,
          ).toBe(200)

          const validBody = JSON.stringify({
            id: "evt_wh_ok",
            type: "checkout.session.completed",
            data: {
              object: {
                id: "cs_api_1",
                payment_status: "paid",
                customer: "cus_sam",
                metadata: { person_id: personId, pack_id: "pack_25" },
              },
            },
          })
          const validSig = yield* signBody(validBody)
          expect(
            (
              yield* call(
                undefined,
                new Request(`https://smithers.sh${BILLING_WEBHOOK_ROUTE}`, {
                  method: "POST",
                  headers: { "stripe-signature": validSig },
                  body: validBody,
                }),
              )
            ).status,
          ).toBe(200)
          expect(started.some((s) => s.flow === BillingFlows.CreditTopUp)).toBe(true)

          starterMode = "conflict"
          expect(
            (
              yield* call(
                undefined,
                new Request(`https://smithers.sh${BILLING_WEBHOOK_ROUTE}`, {
                  method: "POST",
                  headers: { "stripe-signature": validSig },
                  body: validBody,
                }),
              )
            ).status,
          ).toBe(200)

          starterMode = "unavailable"
          expect(
            (
              yield* call(
                undefined,
                new Request(`https://smithers.sh${BILLING_WEBHOOK_ROUTE}`, {
                  method: "POST",
                  headers: { "stripe-signature": validSig },
                  body: validBody,
                }),
              )
            ).status,
          ).toBe(503)
          starterMode = "ok"

          // Admin grant: 405, 401, 403 non-admin, 403 agent, 413 too large, 400 bad body, 404 unknown login, 503 db err, 503 starter err, 202 ok
          expect(
            (yield* call(adminActor, new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`))).status,
          ).toBe(405)
          expect(
            (yield* call(undefined, new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, { method: "POST" })))
              .status,
          ).toBe(401)
          expect(
            (
              yield* call(
                contribActor,
                new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, {
                  method: "POST",
                  body: JSON.stringify({ login: "contrib-sam", amountUsd: 10 }),
                }),
              )
            ).status,
          ).toBe(403)
          expect(
            (
              yield* call(
                agentAdmin,
                new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, {
                  method: "POST",
                  body: JSON.stringify({ login: "contrib-sam", amountUsd: 10 }),
                }),
              )
            ).status,
          ).toBe(403)
          expect(
            (
              yield* call(
                adminActor,
                new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, {
                  method: "POST",
                  body: "x".repeat(20_000),
                }),
              )
            ).status,
          ).toBe(413)
          for (const bad of [
            "{bad",
            JSON.stringify({ login: "   ", amountUsd: 10 }),
            JSON.stringify({ login: "contrib-sam", amountUsd: 0 }),
            JSON.stringify({ login: "contrib-sam", amountUsd: 2000 }),
          ]) {
            expect(
              (
                yield* call(
                  adminActor,
                  new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, { method: "POST", body: bad }),
                )
              ).status,
            ).toBe(400)
          }
          expect(
            (
              yield* call(
                adminActor,
                new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, {
                  method: "POST",
                  body: JSON.stringify({ login: "does-not-exist", amountUsd: 10 }),
                }),
              )
            ).status,
          ).toBe(404)
          expect(
            (
              yield* call(
                adminActor,
                new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, {
                  method: "POST",
                  body: JSON.stringify({ login: "contrib-sam", amountUsd: 10 }),
                }),
                { useBrokenDb: true },
              )
            ).status,
          ).toBe(503)

          starterMode = "unavailable"
          expect(
            (
              yield* call(
                adminActor,
                new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, {
                  method: "POST",
                  body: JSON.stringify({ login: "contrib-sam", amountUsd: 10 }),
                }),
              )
            ).status,
          ).toBe(503)
          starterMode = "ok"

          const grantOk = yield* call(
            adminActor,
            new Request(`https://smithers.sh${BILLING_ADMIN_GRANT_ROUTE}`, {
              method: "POST",
              body: JSON.stringify({ login: "contrib-sam", amountUsd: 15, note: "Great PR" }),
            }),
          )
          expect(grantOk.status).toBe(202)
          expect(started.some((s) => s.flow === BillingFlows.AdminGrant)).toBe(true)
        }),
      ).pipe(Effect.provide(dbLayer)),
    )
  })
})
