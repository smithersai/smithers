/*
 * The `billing` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `billing` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "billing", label: "Billing", summary: "Balance and plan" }

/** `billing.balance`, the one billing flow every session registers. */
export const billingBalanceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "billing.balance",
    summary: "Show your balance",
    runtime: ["identity"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.showBalance()
  })
]

/** The checkout and portal flows, registered in the admin plugin only (§17.4). */
export const billingPlanFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * §17.4: no top-up or checkout flow is exposed to an MVP account. Every
     * alpha account IS an MVP account, so these two register in the admin
     * plugin only — absent from the registry for everyone else, not hidden,
     * so the slash menu never advertises "opens Stripe checkout" to a user
     * who has no checkout. Payment is the human's act alone: user-only, like
     * sign-in.
     */
    name: "billing.upgrade",
    summary: "Upgrade your plan (opens Stripe checkout)",
    runtime: ["billing.checkout"],
    userOnly: true,
    userOnlyReason: "external checkout with real money; the human clicks",
    args: "[plan]",
    requires: ["signed-in"],
    input: Schema.Struct({ plan: Schema.optional(Schema.String) }),
    handler: ({ plan }) => actions.startCheckout(plan)
  }),
  flow({
    name: "billing.portal",
    summary: "Manage billing (opens the Stripe portal)",
    runtime: ["billing.checkout"],
    userOnly: true,
    userOnlyReason: "the external billing portal; the human clicks",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.openBillingPortal()
  })
]
