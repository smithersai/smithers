/*
 * The `smithers` flows: the agent about itself. One module per namespace: a
 * lane that adds or edits a flow here touches no other flow module, and
 * Flows.ts registers each block in the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `smithers` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "smithers", label: "Smithers", summary: "Smithers itself" }

/** The `smithers.*` flows registered as one aggregator block. */
export const smithersFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  /*
   * The name proof. A live model once introduced itself as "Smith Smithers",
   * so the identity is a constant the app renders (Onboarding.ts
   * identityMessage), never a sentence the model composes: the human's slash,
   * a pill and the agent's tool call all read the same line. Registered on
   * every host, because the answer is a fact of the app and not of the chat
   * seat; a host without an agent still has a Smithers to name.
   */
  flow({
    name: "smithers.who",
    summary: "Say who Smithers is and what it hands off",
    input: NoPayload,
    handler: () => actions.introduce()
  })
]
