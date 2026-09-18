/*
 * The `tab` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload, CardTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `tab` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "tab", label: "Sessions", summary: "Card tabs" }

/** `tab.read`, registered after `chat.reload`. */
export const tabHarnessFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * Smithers is the first tab and reads every other one: the model (and a
     * human, via slash) gets a terminal or agent tab's recent output as text,
     * or a card tab's payload. The tab list itself rides every turn's runtime
     * context, so the model already knows the ids.
     */
    name: "tab.read",
    summary: "Read another session's recent output",
    args: "<tabId>",
    input: Schema.Struct({ tab: Schema.String }),
    handler: ({ tab }) => actions.readTab(tab)
  })
]

/** The session tab flows: card, select, close, menu. */
export const tabFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /* Pins a card the agent just rendered into its own tab: an ordinary act. */
    name: "tab.card",
    summary: "Open a card in a tab",
    args: "<cardId>",
    input: CardTarget,
    handler: ({ cardId }) => actions.openCardTab(cardId)
  }),
  flow({
    name: "tab.select",
    summary: "Select a session",
    hidden: true,
    userOnly: true,
    userOnlyReason: "focus is the human's",
    args: "<tabId | 1-9>",
    input: Schema.Struct({ tab: Schema.String }),
    handler: ({ tab }) => actions.selectTab(tab)
  }),
  flow({
    /* Closing stops a process: the agent asks, the human confirms (and a live process asks once more). */
    name: "tab.close",
    summary: "Close a session",
    confirm: "close the session",
    args: "[tabId]",
    input: Schema.Struct({ tabId: Schema.optional(Schema.String) }),
    handler: ({ tabId }) => actions.closeTab(tabId)
  }),
  flow({
    name: "tab.close.confirm",
    summary: "Close the session and stop its process",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.confirmTabClose()
  }),
  flow({
    name: "tab.close.cancel",
    summary: "Keep the session open",
    hidden: true,
    userOnly: true,
    userOnlyReason: "a confirm-dialog answer is the human's",
    input: NoPayload,
    handler: () => actions.cancelTabClose()
  }),
  flow({
    name: "tab.menu",
    summary: "Open the new session menu",
    hidden: true,
    userOnly: true,
    userOnlyReason: "opening a menu is the human's gesture",
    args: "[repoKey]",
    input: Schema.Struct({ repo: Schema.optional(Schema.String) }),
    handler: ({ repo }) => actions.toggleTabMenu(repo)
  })
]
