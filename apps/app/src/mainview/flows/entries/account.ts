/*
 * The `account` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `account` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "account", label: "Account", summary: "Who is signed in and what Smithers knows about them" }

/** The `account` flows registered as one aggregator block. */
export const accountFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * The Account chrome button's flow (factory mock 21, design session §6c):
   * a read-only card of seam facts — the GitHub login, the scopes the
   * identity worker states, the allowlist answer, the boxes the workspaces
   * seam has listed — with the Sign out door. Signed out it renders the
   * sign-in step (auth.prompt's message), never an empty account, so it has
   * no `requires: ["signed-in"]`: the signed-out answer IS the card.
   */
  flow({
    name: "account.show",
    summary: "Show the signed-in account: GitHub login and scopes, access, boxes, and sign out",
    runtime: ["identity"],
    input: NoPayload,
    handler: () => actions.showAccount()
  })
]
