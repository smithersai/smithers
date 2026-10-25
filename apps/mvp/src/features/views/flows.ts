import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Interactions } from "@smthrs/views"
import { Schema } from "effect"
import { MAX_SUBMIT_LABEL, VIEW_SIZES } from "./contract"
import { FORM_REFUSALS } from "./form"
import { BoundedObject, IssuesProps, RepoProps, ViewTitle } from "./schema"

// The agent talks through UI (decision 0004, docs/features/views.md): three flows over the conversation's views.
//
//   ui/form { title, schema, submitLabel? }: the agent asks with a form
//     ui/form/check (sealed: the schema renders fields and asks for no secret; the view's id)
//     ─▶ ui/form/show: ChatApi adds the `form` view. The person's submission is their next question, with the values.
//   ui/render { description, size?, data? }: the agent shows a view it describes
//     ui/render/plan (sealed: the view's id and size)
//     ─▶ ui/render/write: the renderer (the model endpoint's `renderer` role) writes a TSX module; ChatApi checks and
//        renders it in its presentation realm, and a failure goes back to the renderer, at most twice
//   view/set-state { viewId, revision, event }: one move in a generated view, a person's click or the agent's
//     view/set-state/send: ChatApi runs the module's `reduce` from the state it keeps
//   ui/repo { repo, ref?, kind?, path? }: a repository's own view in the chat, small, full screen at its own URL
//     ui/repo/plan (sealed: the view's id) ─▶ ui/repo/show: ChatApi adds the `repo` view
//   ui/issues { repo }: a repository's issues view in the chat, full screen at its issues page
//     ui/issues/plan (sealed: the view's id) ─▶ ui/issues/show: ChatApi adds the `issues` view
//
// Each runs on this device's engine (placement `client`); what its steps run on is injected
// (src/features/views/steps.ts), so only an engine's host imports that.

/** The form can't be shown: by why (src/features/views/form.ts). */
export class FormRefused extends Schema.TaggedError<FormRefused>()("@smthrs/mvp/views/FormRefused", {
  reason: Schema.Literals(FORM_REFUSALS),
}) {}

/** The person may not add to the conversation, or move in its views: signed out, or not a Member. */
export class ViewForbidden extends Schema.TaggedError<ViewForbidden>()("@smthrs/mvp/views/ViewForbidden", {}) {}

/** ChatApi couldn't take the view or the move: unreachable, or failing. */
export class ViewUnavailable extends Schema.TaggedError<ViewUnavailable>()("@smthrs/mvp/views/ViewUnavailable", {}) {}

/** The renderer's module still failed its check or render after its corrections, or the renderer had no model. */
export class ViewNotRendered extends Schema.TaggedError<ViewNotRendered>()("@smthrs/mvp/views/ViewNotRendered", {
  reason: Schema.Literals(["invalid", "unavailable", "unconfigured"]),
}) {}

/** The move was against an older board: the view is at `revision` now. */
export class ViewStale extends Schema.TaggedError<ViewStale>()("@smthrs/mvp/views/ViewStale", {
  revision: Schema.Number,
}) {}

/** The view isn't one that takes this move: no such generated view, or an event it doesn't declare as `state`. */
export class MoveRefused extends Schema.TaggedError<MoveRefused>()("@smthrs/mvp/views/MoveRefused", {}) {}

/** ChatApi refused the repository's view or its issues view: its id is another view's. */
export class TemplateRefused extends Schema.TaggedError<TemplateRefused>()("@smthrs/mvp/views/TemplateRefused", {}) {}

/**
 * How long a step keeps trying while ChatApi is unreachable: 500 ms doubling to 8 s, for at most 2 minutes. A refusal
 * is final.
 */
export const VIEW_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 8_000,
  expirationMs: 2 * 60_000,
  nonRetryable: [
    "@smthrs/mvp/views/FormRefused",
    "@smthrs/mvp/views/ViewForbidden",
    "@smthrs/mvp/views/ViewNotRendered",
    "@smthrs/mvp/views/ViewStale",
    "@smthrs/mvp/views/MoveRefused",
    "@smthrs/mvp/views/TemplateRefused",
  ],
})

/** Where a view shows first. */
export const Size = Schema.Literals(VIEW_SIZES)

const formPayload = {
  title: ViewTitle,
  schema: BoundedObject,
  submitLabel: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_SUBMIT_LABEL))),
}

/** A form the policy allowed, with the id its view gets. */
export const CheckedForm = Schema.Struct({
  viewId: Schema.String,
  title: ViewTitle,
  schema: BoundedObject,
  submitLabel: Schema.String,
})
export type CheckedForm = typeof CheckedForm.Type

/** What `ui/form` answers: the form it added. */
export const FormShown = Schema.Struct({ viewId: Schema.String, shown: Schema.Literal("form") })
export type FormShown = typeof FormShown.Type

/** The step: checks the form's schema and picks the view's id. Sealed, so a resumed run adds the very same form. */
export const CheckForm = Action.make("ui/form/check", {
  payload: formPayload,
  success: CheckedForm,
  error: FormRefused,
  tier: "sealed",
})

/** The step: adds the form to the conversation through ChatApi, which checks it again. */
export const ShowForm = Action.make("ui/form/show", {
  payload: CheckedForm.fields,
  success: FormShown,
  error: Schema.Union([FormRefused, ViewForbidden, ViewUnavailable]),
  retryPolicy: VIEW_RETRY,
})

/** `ui/form`: the agent asks the person with a form in the chat. */
export const AskWithForm = Flow.make("ui/form", {
  description: "Ask the person for any input you need with a form in the chat; never ask for values in prose. " +
    "schema is a JSON Schema object whose properties are the fields (each with a title; string, number, boolean or " +
    "enum), with required listing the ones the person must fill. Never ask for a password, token or other secret: " +
    "secrets are added in Settings. submitLabel names the button (default \"Send\"). The form ends your answer: " +
    "finish with only 'Form ready.', without repeating the question or promising later work. The person's submission " +
    "arrives as their next question: the submit label, then the " +
    "values they sent. Answers { viewId, shown: \"form\" }.",
  modelInvocable: true,
  payload: formPayload,
  success: FormShown,
  error: Schema.Union([FormRefused, ViewForbidden, ViewUnavailable]),
  body: Node.capture({ check: CheckForm.name, show: ShowForm.name }, (form) =>
    CheckForm.call(form).pipe(
      Node.bindPlanned(Node.capture({ show: ShowForm.name }, (checked) => ShowForm.call(checked))),
    )),
}).annotate(Flow.Placement, Placement.client())

const renderPayload = {
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  size: Schema.optional(Size),
  data: Schema.optional(BoundedObject),
}

/** A view to write, with the id it gets and where it shows first. */
export const PlannedView = Schema.Struct({
  viewId: Schema.String,
  description: Schema.String,
  size: Size,
  data: Schema.optional(BoundedObject),
})
export type PlannedView = typeof PlannedView.Type

/** What `ui/render` answers: the view it added, its title, where it shows, and its revision. */
export const ViewShown = Schema.Struct({
  viewId: Schema.String,
  title: Schema.String,
  size: Size,
  revision: Schema.Number,
  interactions: Interactions.Declared,
})
export type ViewShown = typeof ViewShown.Type

/** The step: picks the view's id and size. Sealed, so a resumed run writes the very same view. */
export const PlanView = Action.make("ui/render/plan", {
  payload: renderPayload,
  success: PlannedView,
  tier: "sealed",
})

/**
 * The step: the renderer writes the module, and ChatApi checks, renders and keeps it. A module ChatApi refuses goes
 * back to the renderer with what went wrong, at most twice. Each model call is a sealed `ModelStep`.
 */
export const WriteView = Action.make("ui/render/write", {
  payload: PlannedView.fields,
  success: ViewShown,
  error: Schema.Union([ViewNotRendered, ViewForbidden, ViewUnavailable]),
  retryPolicy: VIEW_RETRY,
})

/** `ui/render`: the agent shows a view it describes, small in the chat, or full screen. */
export const RenderView = Flow.make("ui/render", {
  description: "Show complex information or something to play with as a view in the chat: a comparison, a table, " +
    "a chart of bars, a board or a game such as tic-tac-toe. Describe what to show in description; pass the facts " +
    "to show as data. A renderer writes it; the person can open it full screen. size \"inline\" (the default) shows " +
    "it in the message, \"full\" opens it full size. Keep a plain answer as text, prefer a form (ui/form) to ask " +
    "for input, and show a repository with ui/repo and its issues with ui/issues. A move in a game is a click in " +
    "the view; no call is needed. Answers { viewId, title, size, revision, interactions }.",
  modelInvocable: true,
  payload: renderPayload,
  success: ViewShown,
  error: Schema.Union([ViewNotRendered, ViewForbidden, ViewUnavailable]),
  body: Node.capture({ plan: PlanView.name, write: WriteView.name }, (task) =>
    PlanView.call(task).pipe(
      Node.bindPlanned(Node.capture({ write: WriteView.name }, (planned) => WriteView.call(planned))),
    )),
}).annotate(Flow.Placement, Placement.client())

const statePayload = {
  viewId: Schema.String.check(Schema.isUUID()),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  event: Interactions.Event,
}

/** What `view/set-state` answers: the view's revision after the move. */
export const StateSet = Schema.Struct({ viewId: Schema.String, revision: Schema.Number })
export type StateSet = typeof StateSet.Type

/** The step: ChatApi makes the move from the state it keeps. */
export const SendState = Action.make("view/set-state/send", {
  payload: statePayload,
  success: StateSet,
  error: Schema.Union([ViewStale, MoveRefused, ViewForbidden, ViewUnavailable]),
  retryPolicy: VIEW_RETRY,
})

/** `view/set-state`: one move in a generated view, from a person's click or the agent. */
export const SetViewState = Flow.make("view/set-state", {
  description: "Make one move in a generated view: the event it declares as a state event (from ui/render's " +
    "interactions), with its arg (for a board cell, its index). revision is the view's current revision; " +
    "ViewStale says the view moved on, with the revision it is at. Answers { viewId, revision }.",
  modelInvocable: true,
  payload: statePayload,
  success: StateSet,
  error: Schema.Union([ViewStale, MoveRefused, ViewForbidden, ViewUnavailable]),
  body: Node.capture({ send: SendState.name }, (move) => SendState.call(move)),
}).annotate(Flow.Placement, Placement.client())

/**
 * The branch conversation the person's tab showed when they asked (decision 0013 §1); the home conversation when absent.
 * An agent's call goes to its answer's conversation instead, whatever this says (src/features/views/conversation.ts).
 */
const conversationField = { conversationId: Schema.optional(Schema.String.check(Schema.isUUID())) }

const repoPayload = { ...RepoProps.fields, ...conversationField }

/** A repository's view to add, with the id it gets. */
export const PlannedRepo = Schema.Struct({ viewId: Schema.String, ...repoPayload })
export type PlannedRepo = typeof PlannedRepo.Type

/** What `ui/repo` and `ui/issues` answer: the view they added. */
export const TemplateShown = Schema.Struct({ viewId: Schema.String, shown: Schema.Literals(["repo", "issues"]) })
export type TemplateShown = typeof TemplateShown.Type

const templateErrors = Schema.Union([TemplateRefused, ViewForbidden, ViewUnavailable])

/** The step: picks the view's id. Sealed, so a resumed run adds the very same view. */
export const PlanRepo = Action.make("ui/repo/plan", { payload: repoPayload, success: PlannedRepo, tier: "sealed" })

/** The step: adds the repository's view to the conversation through ChatApi. */
export const ShowRepoView = Action.make("ui/repo/show", {
  payload: PlannedRepo.fields,
  success: TemplateShown,
  error: templateErrors,
  retryPolicy: VIEW_RETRY,
})

/** `ui/repo`: the agent, or a person's `/repo`, shows a repository's own view in the chat. */
export const ShowRepo = Flow.make("ui/repo", {
  description: "Show a repository in the chat as its own repository view: small in the message, and the person can " +
    "open it full screen. repo is owner/name. ref (a branch, tag or commit) and path (a directory or file from the " +
    "root) are optional: the default branch's root otherwise. Use it whenever the person asks to see or show a " +
    "repository, a folder or a file of one; never ui/render for a repository. It doesn't move the person's tab: to " +
    "take them to the repository's page instead, use app/navigate. Answers { viewId, shown: \"repo\" }.",
  modelInvocable: true,
  payload: repoPayload,
  success: TemplateShown,
  error: templateErrors,
  body: Node.capture({ plan: PlanRepo.name, show: ShowRepoView.name }, (repo) =>
    PlanRepo.call(repo).pipe(
      Node.bindPlanned(Node.capture({ show: ShowRepoView.name }, (planned) => ShowRepoView.call(planned))),
    )),
}).annotate(Flow.Placement, Placement.client())

const issuesPayload = { ...IssuesProps.fields, ...conversationField }

/** A repository's issues view to add, with the id it gets. */
export const PlannedIssues = Schema.Struct({ viewId: Schema.String, ...issuesPayload })
export type PlannedIssues = typeof PlannedIssues.Type

/** The step: picks the view's id. Sealed, so a resumed run adds the very same view. */
export const PlanIssues = Action.make("ui/issues/plan", { payload: issuesPayload, success: PlannedIssues, tier: "sealed" })

/** The step: adds the repository's issues view to the conversation through ChatApi. */
export const ShowIssuesView = Action.make("ui/issues/show", {
  payload: PlannedIssues.fields,
  success: TemplateShown,
  error: templateErrors,
  retryPolicy: VIEW_RETRY,
})

/** `ui/issues`: the agent, or a person's `/issues`, shows a repository's issues view in the chat. */
export const ShowIssues = Flow.make("ui/issues", {
  description: "Show a repository's issues in the chat as its issues view: small in the message, and the person can " +
    "open the whole list. repo is owner/name. Use it whenever the person asks to see or show a repository's issues; " +
    "never ui/render for them. Answers { viewId, shown: \"issues\" }.",
  modelInvocable: true,
  payload: issuesPayload,
  success: TemplateShown,
  error: templateErrors,
  body: Node.capture({ plan: PlanIssues.name, show: ShowIssuesView.name }, (issues) =>
    PlanIssues.call(issues).pipe(
      Node.bindPlanned(Node.capture({ show: ShowIssuesView.name }, (planned) => ShowIssuesView.call(planned))),
    )),
}).annotate(Flow.Placement, Placement.client())
