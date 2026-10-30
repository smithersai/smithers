import type { registry } from "./registry"

// Person-only acts (decision 0017, slice 0, docs/features/sign-in.md#run-credentials): what only the person's own press
// does. The list is the registry's: every flow with a `userOnlyReason` (src/flows/registry.ts) is a key below, and the
// compiler refuses one missing or one too many, so the two can't drift. Each says how the server keeps it the person's:
// the route that refuses anyone acting for them (`403 person_only`), or why no server route needs to.
// src/flows/registry.test.ts holds each `route` to it. ChatApi reads it (worker/Actor.ts) when it mints a run
// credential; the engine reads it to send a person's own press of a route-kept flow in their session
// (src/flows/credentials.ts). Nothing here imports a library, so every side can.

type Registry = typeof registry
type FlowName = keyof Registry & string

/** The registry's person-only flows: each entry with a `userOnlyReason`. */
export type PersonOnlyFlow = {
  [N in FlowName]: Registry[N] extends { readonly userOnlyReason: string } ? N : never
}[FlowName]

/**
 * How a person-only flow stays the person's: its run is the person's act, whose `route` refuses anyone acting for them;
 * or only the person `starts` it, at a route that refuses an `act`, while the run itself acts as an agent; or it reaches
 * no server route at all (`device`), and says why.
 */
export type PersonOnlyEnforcement =
  | { readonly route: string }
  | { readonly starts: string }
  | { readonly device: string }

/** Every person-only flow of the registry, and how the server keeps it the person's. */
export const PERSON_ONLY_FLOWS = {
  "auth/refresh": { device: "It asks the tab that started it to read its own session again; it reaches no route of its own." },
  "timeline/summarize": { device: "The device projects conversation labels and reaches only the metered model role; no approval or shared write authority is granted." },
  "repo/about": { device: "A repository's page reads what GitHub says of it through RepoApi's about route, which any visitor may read; it grants nothing." },
  "chat/Answer": { starts: "POST /api/questions" },
  "chat/Close": {
    device: "The asking tab settles its own answer through the answer route its agent writes; it grants nothing more.",
  },
  "chat/edit": { device: "It takes a question back from this device's outbox, which no server route serves." },
  "run/answer": { route: "POST /api/runs/<id>/answer" },
  "run/deliver": { device: "It delivers an answer the server already recorded to this device's engine." },
  "flow/answer": { route: "POST /api/flow-drafts/<id>/answers" },
  "flow/run/prompt": { device: "flow/run starts it as its child; its requests are the agent's, under its credential." },
  "branch/share": { route: "POST /api/branches/<id>/shares" },
  "terminal/open": { route: "POST /api/terminals" },
  "issue/commitment": { route: "POST /api/repos/<owner>/<name>/writes" },
  "issue/triage": { route: "POST /api/repos/<owner>/<name>/writes" },
  "triage/run": { route: "POST /api/repos/<owner>/<name>/writes" },
  "triage/enable": { route: "POST /api/repos/<owner>/<name>/writes" },
  "triage/pause": { route: "POST /api/repos/<owner>/<name>/writes" },
  "todo/commit": { route: "POST /api/repos/<owner>/<name>/stack" },
  "todo/drop": { route: "POST /api/repos/<owner>/<name>/stack" },
  "notification/ack": { route: "POST /api/notifications/ack" },
  "domain/add": { route: "POST /api/repos/<owner>/<name>/domains" },
  "domain/remove": { route: "DELETE /api/repos/<owner>/<name>/domains/<hostname>" },
  "alert/channel": { route: "POST /api/alert-channels" },
  "sandbox/limits": { route: "POST /api/sandbox-limits" },
  "feed/answer": { route: "POST /api/repos/<owner>/<name>/feeds/answers" },
} as const satisfies { readonly [N in PersonOnlyFlow]: PersonOnlyEnforcement }

/** Whether a credential's run may be minted for `flow` at all: no person-only flow whose route refuses an `act`. */
export const refusesCredential = (flow: string): boolean =>
  Object.hasOwn(PERSON_ONLY_FLOWS, flow) && "route" in PERSON_ONLY_FLOWS[flow as PersonOnlyFlow]
