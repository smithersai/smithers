import { Context, Effect, Layer, Schema } from "effect"
import type { ComputePackId } from "../../src/features/billing/contract.ts"

// Dependency-injected billing provider service (ARCH-7, SDK-9, decision 0175).
// ChatApi routes and flows depend on this interface, never on Stripe directly,
// so tests and unconfigured deployments run without Stripe credentials.

export class BillingProviderError extends Schema.TaggedError<BillingProviderError>()(
  "@smthrs/mvp/billing/BillingProviderError",
  {
    code: Schema.Literals(["not_configured", "upstream_error", "invalid_response"]),
    status: Schema.optional(Schema.Number),
  },
) {}

export class BillingWebhookError extends Schema.TaggedError<BillingWebhookError>()(
  "@smthrs/mvp/billing/BillingWebhookError",
  {
    code: Schema.Literals(["not_configured", "invalid_signature", "expired_timestamp", "invalid_payload"]),
  },
) {}

export interface CheckoutRequest {
  readonly personId: string
  readonly login: string
  readonly packId: ComputePackId
  readonly packLabel: string
  readonly amountCents: number
  readonly amountMicroUsd: number
  readonly successUrl: string
  readonly cancelUrl: string
}

export interface CheckoutSession {
  readonly sessionId: string
  readonly url: string
}

export interface TopUpWebhookEvent {
  readonly kind: "checkout.completed"
  readonly eventId: string
  readonly sessionId: string
  readonly personId: string
  readonly packId: ComputePackId
  readonly amountMicroUsd: number
  readonly customerId: string | null
}

export interface IgnoredWebhookEvent {
  readonly kind: "ignored"
  readonly eventId: string
  readonly type: string
}

export type VerifiedWebhookEvent = TopUpWebhookEvent | IgnoredWebhookEvent

export interface BillingProviderService {
  readonly configured: boolean
  readonly createCheckoutSession: (
    request: CheckoutRequest,
  ) => Effect.Effect<CheckoutSession, BillingProviderError>
  readonly verifyWebhook: (
    rawBody: string,
    signatureHeader: string,
  ) => Effect.Effect<VerifiedWebhookEvent, BillingWebhookError>
}

export class BillingProvider extends Context.Service<
  BillingProvider,
  BillingProviderService
>()("@smthrs/mvp/billing/BillingProvider") {}

/** Provider layer when billing checkout is not configured on this deployment. */
export const disabledLayer: Layer.Layer<BillingProvider> = Layer.succeed(
  BillingProvider,
  BillingProvider.of({
    configured: false,
    createCheckoutSession: () => Effect.fail(new BillingProviderError({ code: "not_configured" })),
    verifyWebhook: () => Effect.fail(new BillingWebhookError({ code: "not_configured" })),
  }),
)
