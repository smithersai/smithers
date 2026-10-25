import type { BrowserEngine } from "@smthrs/platform-browser"
import { Schema } from "effect"
import { MAX_ANSWER_CHARS, MAX_INPUT_CHARS, MAX_QUESTIONS, MAX_SOURCE_BYTES, RESERVED_NAMES } from "./contract"
import { DraftStatus, FlowName, Placement, Request } from "./schema"

// Your own flows as the tab knows them (decision 0014 §2, docs/features/flows.md#your-own-flows): each flow's name and
// schemas, all the tab needs to start one and read how it ended. Their declarations (./flows.ts) are made from these
// very objects, with the steps as their bodies; `flow/new` and `flow/run` run an agent, so only an engine's host imports
// that, and the tab never loads @smthrs/agent.

/**
 * A reference with its description, read as a declaration's: a string, or none. The flow's declaration (./flows.ts)
 * carries the same text, so the slash menu, the agent and the drafting catalog read one description.
 */
const described = <const R extends BrowserEngine.FlowReference>(
  reference: R,
  description: string,
): R & { readonly description?: string } => ({ ...reference, description })

/** A name a person's flow may take: the Agent Skills pattern, outside the app's own names. */
export const OwnName = FlowName.check(
  Schema.makeFilter((name: string) => !(RESERVED_NAMES as ReadonlyArray<string>).includes(name)),
)

/** ChatApi couldn't be reached, or failed: the step tries again. */
export class FlowsUnavailable extends Schema.TaggedError<FlowsUnavailable>()("@smthrs/mvp/flows/FlowsUnavailable", {
  status: Schema.optional(Schema.Number),
}) {}

/** ChatApi refused the request, by its code (`forbidden`, `stale_round`, `settled`, ...): final. */
export class FlowsRefused extends Schema.TaggedError<FlowsRefused>()("@smthrs/mvp/flows/FlowsRefused", {
  status: Schema.Number,
  code: Schema.String,
}) {}

/** The person has no flow by that name, or no such revision of it. */
export class FlowNotFound extends Schema.TaggedError<FlowNotFound>()("@smthrs/mvp/flows/FlowNotFound", {}) {}

/** The flow's source fails a check the engine runs before it runs or saves it, named by `check`. */
export class FlowInvalid extends Schema.TaggedError<FlowInvalid>()("@smthrs/mvp/flows/FlowInvalid", {
  check: Schema.String,
}) {}

/**
 * The flow's code needs a machine: it imports a module only a machine provides, or declares a capability only a
 * machine grants (./source.ts `needsMachine`), and no host runs a person's code on a machine yet (decision 0005).
 * Final: it fails the run before anything runs.
 */
export class FlowNeedsSandbox extends Schema.TaggedError<FlowNeedsSandbox>()("@smthrs/mvp/flows/FlowNeedsSandbox", {}) {}

// How a run of a person's code in the QuickJS realm fails (`flow/run/code`, ./flows.ts), one tag per thing the person
// fixes: the run page shows a failure by its tag (docs/features/runs.md), and `code` is the closed code the logs, counts
// and tests read. None carries the code's source, its values or the realm's message.

/** The code ran past a limit: the realm's time, memory or size (`limit_exceeded`), or its host calls (`too_many_calls`). */
export class FlowLimitExceeded extends Schema.TaggedError<FlowLimitExceeded>()("@smthrs/mvp/flows/FlowLimitExceeded", {
  code: Schema.Literals(["limit_exceeded", "too_many_calls"]),
}) {}

/** The code loaded a module the realm doesn't provide. */
export class FlowImportRefused extends Schema.TaggedError<FlowImportRefused>()("@smthrs/mvp/flows/FlowImportRefused", {
  code: Schema.Literal("forbidden_import"),
}) {}

/**
 * The code made a call its flow may not: one its `flows` list doesn't name (`action_not_allowed`), an agent step on a
 * seat other than `agent` (`seat`), or a payload the called flow won't read (`payload`).
 */
export class FlowCallRefused extends Schema.TaggedError<FlowCallRefused>()("@smthrs/mvp/flows/FlowCallRefused", {
  code: Schema.Literals(["action_not_allowed", "seat", "payload"]),
}) {}

/**
 * The code didn't run: it doesn't compile or its bytes changed (`invalid_source`), it threw or failed
 * (`execution_failed`), the realm couldn't start (`runtime_failed`), or Smithers' realm changed since the run began
 * (`version`, which Retry fixes).
 */
export class FlowCodeFailed extends Schema.TaggedError<FlowCodeFailed>()("@smthrs/mvp/flows/FlowCodeFailed", {
  code: Schema.Literals(["invalid_source", "execution_failed", "runtime_failed", "version"]),
}) {}

/** How a person's code fails in the realm. */
export const CodeFailure = Schema.Union([FlowLimitExceeded, FlowImportRefused, FlowCallRefused, FlowCodeFailed])
export type CodeFailure = typeof CodeFailure.Type

/**
 * The agent an agent step of a person's flow asked couldn't finish: the model failed, or the run ran out of frames. A
 * plain tagged value, because the flow's plan fails with it as a constant (`Node.fail`), which carries only its JSON.
 */
export const FlowAgentFailed = Schema.Struct({ _tag: Schema.Literal("@smthrs/mvp/flows/FlowAgentFailed") })

/** Another of the person's flows holds the name. */
export class NameTaken extends Schema.TaggedError<NameTaken>()("@smthrs/mvp/flows/NameTaken", {}) {}

/** The draft can't be saved yet: `code` says why (`not_ready`, `checks`, `needs_you`). */
export class DraftNotReady extends Schema.TaggedError<DraftNotReady>()("@smthrs/mvp/flows/DraftNotReady", {
  code: Schema.String,
}) {}

/** What a flow's request to ChatApi can fail with. */
export const RouteFailure = Schema.Union([FlowsUnavailable, FlowsRefused])
export type RouteFailure = typeof RouteFailure.Type

/** How a draft round ended: its draft, its round and its status, and the name it drafts. */
export const RoundEnded = Schema.Struct({
  draftId: Schema.String,
  round: Schema.Number,
  status: DraftStatus,
  name: Schema.String,
})
export type RoundEnded = typeof RoundEnded.Type

/**
 * `flow/new { name, request }`: drafts a flow of yours, one round. Its execution id `<draftId>:<round>` names the
 * draft and the round; any other id starts round 0 of a new draft. The name of a flow you have edits it.
 */
export const FlowNewReference = described(
  {
    _tag: "flow/new",
    payloadSchema: Schema.Struct({
      name: OwnName.annotate({ description: "The flow's name: lowercase letters, digits and hyphens" }),
      request: Request.annotate({ description: "What the flow should do" }),
    }),
    successSchema: RoundEnded,
    errorSchema: RouteFailure,
  },
  "Draft a flow of your own from what it should do, under name. Answers with the draft's id and status; " +
    "the person sees the draft and saves or runs it from there, so drafting is all that asking to create a flow " +
    "needs: don't save or run it unless they asked to. A name you already have edits that flow.",
)

/** One answer to a round's question. */
export const Answer = Schema.Struct({
  id: Schema.String.check(Schema.isBetweenLength(1, 64)),
  value: Schema.Trim.check(Schema.isBetweenLength(1, MAX_ANSWER_CHARS)),
})

/** `flow/answer { draftId, round, answers }`: the person's answers, which start the draft's next round. */
export const FlowAnswerReference = described(
  {
    _tag: "flow/answer",
    payloadSchema: Schema.Struct({
      draftId: Schema.String.check(Schema.isUUID()),
      round: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      answers: Schema.Array(Answer).check(Schema.isBetweenLength(1, MAX_QUESTIONS)),
    }),
    successSchema: Schema.Struct({ draftId: Schema.String, round: Schema.Number }),
    errorSchema: RouteFailure,
  },
  "Answer a draft round's questions; the next round drafts with them.",
)

/** What `flow/save` answers: the flow and the revision the draft became. */
export const SavedFlow = Schema.Struct({ flowId: Schema.String, name: Schema.String, revision: Schema.Number })

/** `flow/save { draftId }`: a ready draft becomes your flow. */
export const FlowSaveReference = described(
  {
    _tag: "flow/save",
    payloadSchema: Schema.Struct({ draftId: Schema.String.check(Schema.isUUID()) }),
    successSchema: SavedFlow,
    errorSchema: Schema.Union([FlowsUnavailable, FlowsRefused, NameTaken, DraftNotReady]),
  },
  "Save a ready draft as your flow, or as the next revision of the flow it edits.",
)

/** `flow/run { name, input?, revision? }`: runs your flow; `revision` pins one, the latest unless set. */
export const FlowRunReference = described(
  {
    _tag: "flow/run",
    payloadSchema: Schema.Struct({
      name: FlowName.annotate({ description: "The flow's name" }),
      input: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_INPUT_CHARS)).annotate({
        description: "What the flow works on",
      })),
      revision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      flowId: Schema.optional(Schema.String.check(Schema.isUUID()).annotate({
        description: "The flow's id: with a revision, that flow's revision even after it was deleted; Retry sets it",
      })),
    }),
    successSchema: Schema.String,
    errorSchema: Schema.Union([
      FlowsUnavailable,
      FlowsRefused,
      FlowNotFound,
      FlowInvalid,
      FlowNeedsSandbox,
      FlowAgentFailed,
      ...CodeFailure.members,
    ]),
  },
  "Run your flow by name with input, its text to work on. Answers with the flow's answer as text. Code that needs " +
    "a machine fails FlowNeedsSandbox: none is available yet.",
)

/**
 * A loaded flow, pinned: the revision, its code and the realm it runs in (`RealmFlow.version`), what it may call, and
 * the run's input. What `flow/run/code` runs.
 */
export const Pinned = {
  flowId: Schema.String,
  name: Schema.String,
  revision: Schema.Number,
  digest: Schema.String,
  source: Schema.String,
  runtime: Schema.String,
  allowed: Schema.Array(Schema.String),
  input: Schema.String,
}

/** The execution that runs one pinned revision's code in the QuickJS realm, one round per host call (./flows.ts). */
export const FLOW_CODE = "flow/run/code"

/**
 * `flow/run/prompt`: the agent one agent step of a pinned revision asked, on the prompt the step's code rendered, its
 * calls limited to the revision's list.
 */
export const FlowPromptReference = described(
  {
    _tag: "flow/run/prompt",
    payloadSchema: Schema.Struct({
      flowId: Schema.String,
      name: Schema.String,
      revision: Schema.Number,
      digest: Schema.String,
      prompt: Schema.String,
      allowed: Schema.Array(Schema.String),
    }),
    successSchema: Schema.String,
    errorSchema: FlowAgentFailed,
  },
  "Follow the prompt one agent step of a person's flow rendered.",
)

/** `flow/delete { flowId }`: deletes your flow. Runs that pinned a revision keep it. */
export const FlowDeleteReference = described(
  {
    _tag: "flow/delete",
    payloadSchema: Schema.Struct({ flowId: Schema.String.check(Schema.isUUID()) }),
    successSchema: Schema.Struct({ deleted: Schema.Boolean }),
    errorSchema: RouteFailure,
  },
  "Delete one of your flows.",
)

/** `flow/draft/delete { draftId }`: deletes a draft of yours not saved yet, and stops its round on this device. */
export const FlowDraftDeleteReference = described(
  {
    _tag: "flow/draft/delete",
    payloadSchema: Schema.Struct({ draftId: Schema.String.check(Schema.isUUID()) }),
    successSchema: Schema.Struct({ deleted: Schema.Boolean }),
    errorSchema: RouteFailure,
  },
  "Delete a draft of yours that isn't saved yet.",
)

/** `flow/drafts`: your drafts not saved yet. */
export const FlowDraftsReference = described(
  {
    _tag: "flow/drafts",
    payloadSchema: Schema.Struct({}),
    successSchema: Schema.Struct({
      drafts: Schema.Array(Schema.Struct({
        draftId: Schema.String,
        name: Schema.NullOr(Schema.String),
        request: Schema.String,
        status: Schema.String,
      })),
    }),
    errorSchema: RouteFailure,
  },
  "List your drafts that aren't saved yet, newest first: each one's draftId, name (null before its first round " +
    "named it), what you asked for, and its status.",
)

/** `flow/list`: your flows. */
export const FlowListReference = described(
  {
    _tag: "flow/list",
    payloadSchema: Schema.Struct({}),
    successSchema: Schema.Struct({
      flows: Schema.Array(Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        revision: Schema.Number,
        placement: Placement,
      })),
    }),
    errorSchema: RouteFailure,
  },
  "List your own flows: each one's name, description, latest revision, and where it runs: client (here) or " +
    "sandbox (needs a machine, not available yet).",
)

/** One revision of your flow's code, and where it runs. */
export const FlowCode = Schema.Struct({
  flowId: Schema.String,
  name: Schema.String,
  revision: Schema.Number,
  source: Schema.String,
  placement: Placement,
})
export type FlowCode = typeof FlowCode.Type

/** `flow/read { name, revision? }`: your flow's code at `revision`, the latest unless set. */
export const FlowReadReference = described(
  {
    _tag: "flow/read",
    payloadSchema: Schema.Struct({
      name: FlowName.annotate({ description: "The flow's name" }),
      revision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    }),
    successSchema: FlowCode,
    errorSchema: Schema.Union([FlowsUnavailable, FlowsRefused, FlowNotFound]),
  },
  "Read your flow's code, a Flow.make module, at revision, the latest unless set, and where it runs.",
)

/** What `flow/write` answers: the revision the code became, and where it runs. */
export const WrittenFlow = Schema.Struct({
  flowId: Schema.String,
  name: Schema.String,
  revision: Schema.Number,
  placement: Placement,
})

/** `flow/write { name, revision, source }`: new code for your flow, edited from `revision`, as its next revision. */
export const FlowWriteReference = described(
  {
    _tag: "flow/write",
    payloadSchema: Schema.Struct({
      name: FlowName.annotate({ description: "The flow's name" }),
      revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "The revision the code was edited from; refused stale once another revision follows it",
      }),
      source: Schema.String.check(Schema.isBetweenLength(1, MAX_SOURCE_BYTES)).annotate({
        description: "The flow's whole flow.ts: an export default Flow.make(\"<name>\", { ... }) module",
      }),
    }),
    successSchema: WrittenFlow,
    errorSchema: Schema.Union([FlowsUnavailable, FlowsRefused, FlowNotFound, FlowInvalid]),
  },
  "Save new code for your flow as its next revision, edited from revision. Code that needs a machine is saved, " +
    "but runs only on a sandbox, which isn't available yet.",
)
