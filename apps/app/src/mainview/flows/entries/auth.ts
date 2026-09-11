/*
 * The `auth` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, FlowRequirement, Namespace, Recommendation } from "../registry"
import type { CommandActions } from "./Declare"

/** The `auth` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "auth", label: "Sign in", summary: "Sign in and out" }

/** The requirements `auth.sign-in` fulfills; registry.ts flowRequirements aggregates them. */
export const requirements: ReadonlyArray<FlowRequirement> = [
  {
    id: "signed-in",
    // Only the definitive signed-out answer defers; unknown/unavailable
    // identity never blocks a command (the seam discipline: gate on
    // answers, not on silence).
    satisfied: (state) => !state.signedOut,
    fulfill: "auth.sign-in",
    reason: "Sign in with GitHub first"
  },
  {
    /*
     * Repository reads have three sources: the GitHub session (Cloud
     * repositories), a repository opened in this app, or the public catalog
     * repository a signed-out visitor is exploring (its files are anonymous
     * reads on the server). Any one satisfies the reads on its own; signed
     * out with none of them, sign-in is the step.
     */
    id: "repo-source",
    satisfied: (state) => !state.signedOut || state.hasOpenRepos === true || state.publicRepo === true,
    fulfill: "auth.sign-in",
    reason: "Sign in with GitHub, or open a local repository first"
  }
]

/** Signed out, sign-in is the only next step. */
export const recommendations: ReadonlyArray<Recommendation> = [
  { name: "auth.sign-in", when: (state) => state.signedOut, exclusive: true, rank: () => 0 }
]

/** The `auth` flows registered as one aggregator block. */
export const authFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * The OAuth redirect leaves the page (or, natively, opens the system
     * browser): the human's gesture, so user-only — auth.prompt below is the
     * agent's door, rendering this button in the chat.
     */
    name: "auth.sign-in",
    summary: "Sign in with GitHub",
    runtime: ["identity"],
    userOnly: true,
    userOnlyReason: "the GitHub OAuth redirect is the human's browser gesture; the agent renders the step with auth.prompt",
    input: NoPayload,
    handler: () => actions.signIn()
  }),
  flow({
    /*
     * The agent's door to login: it cannot run auth.sign-in (user-only —
     * navigation is the human's act), but it CAN render the step. The
     * message's action IS the sign-in button, one click away.
     */
    name: "auth.prompt",
    summary: "Offer the GitHub sign-in step in the chat",
    runtime: ["identity"],
    input: NoPayload,
    handler: () => actions.promptSignIn()
  }),
  flow({
    /* Signing out needs a session: offering it signed out is the clearest
		   case of a listing that names a step the user cannot take (§1.2). */
    name: "auth.sign-out",
    summary: "Sign out of Smithers",
    runtime: ["identity"],
    userOnly: true,
    userOnlyReason: "dropping the human's session is theirs alone",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.signOut()
  }),
  flow({
    name: "auth.request-access",
    summary: "Request access to Smithers",
    runtime: ["identity"],
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.requestAccess()
  })
]
