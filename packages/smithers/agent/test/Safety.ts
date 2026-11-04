/** Explicit safety decisions shared by tests that are not exercising policy. */
import type { Envelope } from "@smthrs/control/ControlSchema"
import { Layer } from "effect"
import * as Budget from "../src/Budget.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.vibe"

/** Tests in this package deliberately run without quota parking or spend caps. */
export const layer = Layer.merge(
  Budget.layerUnbounded(),
  QuotaPolicy.layerUnclassified()
)

/** Explicit quota decision for an {@link AgentSession} test composition. */
export const quotaPolicy = QuotaPolicy.layerUnclassified()

/** Explicit budget decision for an {@link AgentSession} test composition. */
export const budget = (_envelope: Envelope) => Budget.layerUnbounded()
