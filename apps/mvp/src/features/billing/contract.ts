// Prepaid cloud compute credits contract shared between the browser, ChatApi, and tests (decision 0175).
// Nothing here imports a library so every runtime can import it directly.

/** 1 USD in exact integer micro-dollars (prevents floating-point ledger drift). */
export const MICRO_USD_PER_USD = 1_000_000

/** 1 USD cent in micro-dollars. */
export const MICRO_USD_PER_CENT = 10_000

/** Default multiplier over Cloudflare Containers raw pricing (~2x = ~$0.15/hr on standard-1). */
export const DEFAULT_PRICE_MULTIPLIER = 2

/** Minimum balance required to admit a paid sandbox wake ($0.05 = ~20 min of standard-1). */
export const MIN_ADMIT_MICRO_USD = 50_000

/** Routes for cloud compute billing. */
export const BILLING_ROUTE = "/api/billing"
export const BILLING_ACCOUNT_ROUTE = "/api/billing/account"
export const BILLING_CHECKOUT_ROUTE = "/api/billing/checkout"
export const BILLING_WEBHOOK_ROUTE = "/api/billing/webhook"
export const BILLING_ADMIN_GRANT_ROUTE = "/api/billing/admin/grant"

/** Maximum checkout or grant request body size in bytes. */
export const MAX_BILLING_BODY_BYTES = 16 * 1024

/** Maximum Stripe webhook payload size in bytes. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024

/** How a signed-in person is authorized to run Cloudflare sandboxes and remote jobs. */
export const COMPUTE_ACCESS_MODES = ["deployment", "paid", "none"] as const
export type ComputeAccessMode = (typeof COMPUTE_ACCESS_MODES)[number]

/** Billing mode recorded per sandbox_generations row. */
export const SANDBOX_BILLING_MODES = ["deployment", "paid"] as const
export type SandboxBillingMode = (typeof SANDBOX_BILLING_MODES)[number]

/** Ledger entry kinds. */
export const LEDGER_KINDS = ["topup", "sandbox_usage", "admin_grant", "refund"] as const
export type ComputeLedgerKind = (typeof LEDGER_KINDS)[number]

/** Prepaid top-up packs offered via Stripe Checkout. */
export const COMPUTE_PACKS = [
  { id: "pack_10", label: "$10", amountUsd: 10, amountCents: 1000, amountMicroUsd: 10 * MICRO_USD_PER_USD },
  { id: "pack_25", label: "$25", amountUsd: 25, amountCents: 2500, amountMicroUsd: 25 * MICRO_USD_PER_USD },
  { id: "pack_50", label: "$50", amountUsd: 50, amountCents: 5000, amountMicroUsd: 50 * MICRO_USD_PER_USD },
] as const

export type ComputePack = (typeof COMPUTE_PACKS)[number]
export type ComputePackId = ComputePack["id"]

export const COMPUTE_PACK_IDS: ReadonlyArray<ComputePackId> = COMPUTE_PACKS.map((p) => p.id)

/** @throws {never} */
export const packById = (id: string): ComputePack | undefined =>
  COMPUTE_PACKS.find((p) => p.id === id)

/** Cloudflare Containers instance specs (matches worker/branch/Budget.vibe). */
export const INSTANCE_SPECS: Readonly<
  Record<string, { readonly vcpu: number; readonly memoryGib: number; readonly diskGb: number }>
> = {
  lite: { vcpu: 1 / 16, memoryGib: 0.25, diskGb: 2 },
  basic: { vcpu: 0.25, memoryGib: 1, diskGb: 4 },
  "standard-1": { vcpu: 0.5, memoryGib: 4, diskGb: 8 },
  "standard-2": { vcpu: 1, memoryGib: 6, diskGb: 12 },
  "standard-3": { vcpu: 2, memoryGib: 8, diskGb: 16 },
  "standard-4": { vcpu: 4, memoryGib: 12, diskGb: 20 },
}

/** Cloudflare Containers raw prices in USD per second. */
export const CLOUDFLARE_USD_PER_SECOND = {
  vcpuSecond: 0.000020,
  memoryGibSecond: 0.0000025,
  diskGbSecond: 0.00000007,
} as const

/** Raw Cloudflare USD/second for an instance type (unknown falls back to largest). */
/** @throws {never} */
export const rawUsdPerSecond = (instance: string): number => {
  const size = INSTANCE_SPECS[instance] ?? INSTANCE_SPECS["standard-4"]!
  return (
    size.vcpu * CLOUDFLARE_USD_PER_SECOND.vcpuSecond +
    size.memoryGib * CLOUDFLARE_USD_PER_SECOND.memoryGibSecond +
    size.diskGb * CLOUDFLARE_USD_PER_SECOND.diskGbSecond
  )
}

/** Paid price in micro-USD per second (floating precision before ceiling on charge). */
/** @throws {never} */
export const paidMicroUsdPerSecond = (instance: string, multiplier = DEFAULT_PRICE_MULTIPLIER): number =>
  rawUsdPerSecond(instance) * multiplier * MICRO_USD_PER_USD

/** Exact integer micro-USD charge for `seconds` on `instance`, rounded up to the nearest micro-USD. */
/** @throws {never} */
export const chargeMicroUsd = (
  instance: string,
  seconds: number,
  multiplier = DEFAULT_PRICE_MULTIPLIER,
): number => {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.ceil(paidMicroUsdPerSecond(instance, multiplier) * seconds)
}

/** Estimated hourly rate in USD for display (e.g. ~$0.15/hr on standard-1). */
/** @throws {never} */
export const hourlyUsd = (instance: string, multiplier = DEFAULT_PRICE_MULTIPLIER): number =>
  rawUsdPerSecond(instance) * multiplier * 3600

/** Formats micro-USD into human-readable USD (`$10.00`, `$0.15`, `-$0.02`). */
/** @throws {never} */
export const formatUsd = (microUsd: number): string => {
  const sign = microUsd < 0 ? "-" : ""
  const absUsd = Math.abs(microUsd) / MICRO_USD_PER_USD
  if (absUsd > 0 && absUsd < 0.01) return `${sign}$${absUsd.toFixed(4)}`
  return `${sign}$${absUsd.toFixed(2)}`
}

export interface ComputeLedgerEntry {
  readonly id: string
  readonly kind: ComputeLedgerKind
  readonly amountMicroUsd: number
  readonly balanceAfterMicroUsd: number
  readonly description: string
  readonly createdAt: string
}

export interface ComputeRateSummary {
  readonly instance: string
  readonly vcpu: number
  readonly memoryGib: number
  readonly hourlyUsd: number
}

export interface BillingAccountState {
  readonly balanceMicroUsd: number
  readonly lifetimePurchasedMicroUsd: number
  readonly lifetimeSpentMicroUsd: number
  readonly computeAccess: ComputeAccessMode
  readonly isDeploymentMember: boolean
  readonly minAdmitMicroUsd: number
  readonly stripeConfigured: boolean
  readonly priceMultiplier: number
  readonly defaultInstance: string
  readonly rates: ReadonlyArray<ComputeRateSummary>
  readonly packs: ReadonlyArray<ComputePack>
  readonly ledger: ReadonlyArray<ComputeLedgerEntry>
}

export const BILLING_TELEMETRY = {
  records: [
    "billing.account.load",
    "billing.checkout.start",
    "billing.grant.start",
    "smithers_web_billing_checkouts",
  ],
  fields: ["outcome", "packId", "status", "durationMs"],
} as const
