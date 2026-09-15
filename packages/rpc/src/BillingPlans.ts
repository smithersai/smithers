import { z } from "zod"

export const SandboxEntitlementSchema = z.object({
  concurrentSandboxes: z.number().int(),
  concurrentInUse: z.number().int().nonnegative(),
  idleTimeoutSecs: z.number().int().nonnegative(),
  hoursPerDay: z.number().int(),
  secondsUsedToday: z.number().nonnegative(),
  dayResetsAt: z.string()
})
export const BillingPlanSchema = z.object({
  key: z.enum(["free", "pro", "max"]),
  display_name: z.string(),
  price_cents: z.number().int().nonnegative(),
  interval: z.string(),
  limits: z.object({
    concurrent_sandboxes: z.number().int(),
    idle_timeout_secs: z.number().int().nonnegative(),
    hours_per_day: z.number().int(),
    private_repos: z.number(), storage_bytes: z.number(), ci_minutes: z.number(),
    agent_runs: z.number(), seats: z.number()
  }),
  checkout_available: z.boolean()
})
export const BillingPlansResponseSchema = z.object({
  plans: z.array(BillingPlanSchema), current_plan_key: z.string()
})
export const BillingOverviewSchema = z.object({
  sandbox: z.object({
    plan_key: z.string(), concurrent_sandboxes: z.number().int(),
    concurrent_in_use: z.number().int().nonnegative(), idle_timeout_secs: z.number().int().nonnegative(),
    hours_per_day: z.number().int(), seconds_used_today: z.number().nonnegative(), day_resets_at: z.string()
 })
})
