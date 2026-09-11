/*
 * The `notifications` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `notifications` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "notifications", label: "Notifications", summary: "GitHub notifications" }

/** The `notifications` flows registered as one aggregator block. */
export const notificationsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "notifications.list",
    summary: "Show your notifications",
    runtime: ["cloud"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.listNotifications()
  }),
  flow({
    name: "notifications.read",
    summary: "Mark every notification read",
    runtime: ["cloud"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.markNotificationsRead()
  })
]
