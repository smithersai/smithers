/*
 * The `card` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload, CardTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `card` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "card", label: "Cards", summary: "Maximize and minimize cards" }

/** The `card` flows registered as one aggregator block. */
export const cardFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /* Maximize is the user's explicit act alone (THE EMBED LAW). */
    name: "card.maximize",
    summary: "Maximize a card",
    hidden: true,
    userOnly: true,
    userOnlyReason: "maximizing a card is the human's explicit act (THE EMBED LAW)",
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.maximizeCard(cardId)
  }),
  flow({
    name: "card.minimize",
    summary: "Minimize the maximized card",
    hidden: true,
    userOnly: true,
    userOnlyReason: "minimizing a card is the human's explicit act",
    input: NoPayload,
    handler: () => actions.minimizeCard()
  }),
  flow({
    /* THE FORM LAW: a form card's Cancel. Only form cards dismiss; the handler refuses the rest by kind. */
    name: "card.dismiss",
    summary: "Dismiss a form card",
    hidden: true,
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.dismissCard(cardId)
  })
]
