// Your own flows' contract (decision 0014, docs/features/flows.md#your-own-flows): the one home of the values the tab,
// the engine worker, ChatApi and the tests share. Nothing here imports a library, so every side can.

/**
 * ChatApi's routes for a person's own flows:
 * - `GET /api/flows`: the person's live flows;
 * - `GET /api/flows/source?name=<name>[&revision=<n>]`: one flow's source at a revision, the latest unless set;
 * - `POST /api/flows/save`: a ready draft becomes a flow, or the next revision of the one it edits;
 * - `POST /api/flows/write`: source the person wrote becomes the next revision of their flow;
 * - `POST /api/flows/<id>/delete`: deletes one.
 */
export const FLOWS_ROUTE = "/api/flows"

/** `GET` and `POST /api/flow-drafts/<id>`: a draft round; `POST /api/flow-drafts/<id>/answers`: the person's answers. */
export const FLOW_DRAFTS_ROUTE = "/api/flow-drafts"

/** Electric's `flows`: the signed-in person's live flows. */
export const FLOWS_SHAPE_ROUTE = "/api/shapes/flows"

/** Electric's `flow_drafts`: the signed-in person's drafts. */
export const FLOW_DRAFTS_SHAPE_ROUTE = "/api/shapes/flow-drafts"

/** The Postgres tables the shapes serve. */
export const FLOWS_TABLE = "flows"
export const FLOW_DRAFTS_TABLE = "flow_drafts"

/**
 * A flow's name: the Agent Skills rule, 1 to 64 lowercase letters, digits and single hyphens, starting with a letter and
 * ending without a hyphen.
 */
export const NAME_PATTERN = /^(?=.{1,64}$)[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/

/**
 * Names a person's flow may not take: the app's namespaces (decision 0014 §2), so a person's flow never shadows an app
 * flow, and the app's own slash commands.
 */
export const RESERVED_NAMES = [
  "app",
  "chat",
  "repo",
  "ui",
  "view",
  "flow",
  "run",
  "agent",
  "theme",
  "navigate",
  "web",
  "clone",
] as const

/** The namespaces a person's flow may never call: the authoring and run acts (decision 0014 §11). */
export const FORBIDDEN_CALLS = ["flow/", "run/"] as const

/** A description: 1 to 1,024 characters ([skills]). */
export const MAX_DESCRIPTION_CHARS = 1024

/**
 * The namespace a new draft's id is derived in (RFC 9562 version 5, `@smthrs/crypto`'s `Uuid.v5`): round 0 of a draft
 * started by an agent's call or a slash command names its draft by its own execution, so a step run again after a lost
 * answer or a crash writes the same draft, never a second.
 */
export const DRAFT_ID_NAMESPACE = "e26f87c1-9c9b-4016-8fd7-1f01cea1a54b"

/** What a person asks `flow/new` for: 1 to 4,096 characters. */
export const MAX_REQUEST_CHARS = 4096

/** A flow's source, and a draft's files in all: 64 KiB. */
export const MAX_SOURCE_BYTES = 64 * 1024

/** Questions one round may ask. */
export const MAX_QUESTIONS = 5

/** An answer to one question: 1 to 1,000 characters. */
export const MAX_ANSWER_CHARS = 1000

/** What a run of a person's flow takes as its input: up to 8,000 characters, like a question. */
export const MAX_INPUT_CHARS = 8000

/** The flows a person's flow may list in `flows:`. */
export const MAX_CALLS = 20

/** The largest body the flows and drafts routes read: the files plus room for the rest. */
export const MAX_FLOWS_BODY_BYTES = 80 * 1024

/** How a draft round ends, and the states before and after. */
export const DRAFT_STATUSES = ["drafting", "needs_you", "ready", "failed", "saved", "proposed"] as const

/** The static checks a draft passes before it can be saved (decision 0014 §2, "Static checks"). */
export const CHECKS = ["parses", "name", "description", "calls", "model", "size"] as const

/** The model role every model call of a person's flow uses: the endpoint's `agent` (decision 0011 §3). */
export const FLOW_MODEL_ROLE = "agent"

/** The flows `flow/new`'s drafting agent may call while it drafts: reads only (decision 0014 §2). */
export const AUTHOR_TOOLS = ["repo/tree", "repo/read"] as const

/** The most frames one draft or one run of a person's flow may take. */
export const MAX_FLOW_FRAMES = 8

/**
 * The most host calls, agent steps included, one run of a person's code makes. Each call opens one more round of
 * `flow/run/code`, and each round's credential is minted under the round before it, so this keeps the deepest run well
 * inside the server's credential chain (worker/RunCredentials.ts `MAX_CHAIN`).
 */
export const MAX_REALM_CALLS = 8

/** The route that shows a draft's card full size. */
export const draftPath = (draftId: string): string => `/app/flows/drafts/${draftId}`

/** The route of every flow a person owns. */
export const FLOWS_PATH = "/app/flows"

/** The route that starts a new flow. */
export const NEW_FLOW_PATH = "/app/flows/new"

/** The route that shows a flow's code, to read and edit. */
export const codePath = (name: string): string => `/app/flows/code/${encodeURIComponent(name)}`

/**
 * What your own flows record (docs/observability.md#your-own-flows): authoring rounds and saves, and the routes. None
 * carries a request, a file, a question, an answer or a flow's name: only ids, counts and codes.
 */
export const FLOWS_UI_TELEMETRY = {
  records: [
    "flow.author",
    "smithers_flow_author_rounds",
    "flow.save",
    "flow.save.unconfirmed",
    "flow.write",
    "flow.run.load",
    "flow.run.evaluate",
    "flow.run.call",
    "smithers_flow_saves",
    "smithers_flow_writes",
    "smithers_flow_realm_evaluations",
    "smithers_flow_realm_calls",
    "flow.client.list",
    "flow.client.source",
    "flow.client.draft",
    "flow.client.write_draft",
    "flow.client.answer",
    "flow.client.save",
    "flow.client.write",
    "flow.client.delete",
    "flows.editor.storage",
  ],
  fields: [
    "draftId",
    "round",
    "scope",
    "target",
    "outcome",
    "checks",
    "questions",
    "durationMs",
    "code",
    "placement",
    "collection",
    "kind",
    "receipts",
  ],
} as const

/** The flows pages' buttons, links and lines (MINIMAL TEXT). */
export const NEW_FLOW = "New flow"
export const RUN = "Run"
export const EDIT = "Edit"
export const DELETE = "Delete"
export const CODE = "Code"
export const SAVE = "Save"
export const NO_FLOWS = "No flows yet"
export const MINE = "Mine"

/** Why a flow whose code needs a machine doesn't run: no host runs a person's code on a machine yet. */
export const NEEDS_SANDBOX = "Needs a sandbox"

/** What a refused act on the draft card reads as, by its code: Save's, Draft again's and Delete's. */
export const SAVE_REFUSALS: Readonly<Record<string, string>> = {
  name_taken: "Name taken",
  checks: "A check failed",
  needs_you: "Answer the questions first",
  not_ready: "Not ready",
  unavailable: "Couldn't save. Try again.",
  again_unavailable: "Couldn't start. Try again.",
  delete_unavailable: "Couldn't delete. Try again.",
}

/** Why a draft's round failed, as its card reads it, by its code (./failure.ts); an unknown code reads as itself. */
export const DRAFT_FAILURE_WORDS: Readonly<Record<string, string>> = {
  no_model: "No model available",
  // The person's provider refusing for credit or quota reads the same as a spent budget: neither is "our budget".
  quota: "Model credit or quota used up",
  rate_limited: "Model busy. Try again.",
  undecodable: "The draft didn't come out right",
  frames: "Ran out of steps",
  model_error: "The model failed",
  checks: "A check failed",
  stopped: "Stopped",
  ended: "Ended before it finished",
  // Rounds written before the codes: the agent couldn't draft.
  draft: "Couldn't draft",
}

/** A draft failure's words. */
export const draftFailureWords = (code: string): string =>
  Object.hasOwn(DRAFT_FAILURE_WORDS, code) ? DRAFT_FAILURE_WORDS[code]! : code

/** What a refused write of a flow's code reads as on its page, by its code. */
export const WRITE_REFUSALS: Readonly<Record<string, string>> = {
  stale: "Changed since you opened it",
  not_found: "No such flow",
  unavailable: "Couldn't save. Try again.",
}

/** A refused write's words: `check:<check>` reads `Check failed: <check>`; any other code its words, or itself. */
export const writeRefusalWords = (code: string): string =>
  code.startsWith("check:") ? `Check failed: ${code.slice("check:".length)}` : WRITE_REFUSALS[code] ?? code

/** The code page when the flow can't be read: none by that name, or ChatApi didn't answer. */
export const NO_SUCH_FLOW = "No such flow"
export const COULDNT_READ_FLOW = "Couldn't read this flow"
export const DEVICE_STORAGE_UNAVAILABLE = "Device storage unavailable"
