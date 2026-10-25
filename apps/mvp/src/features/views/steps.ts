import { type FlowEngineLike, ModelStep } from "@smthrs/agent"
import { FlowRuntime, Interpreter } from "@smthrs/flow"
import { type Model, ModelError, ModelEvent, ModelProxy, ModelRequest } from "@smthrs/model"
import { Context, Effect, Layer, Metric } from "effect"
import { requesterOf } from "../../flows/requests"
import { MODEL_ROUTE } from "../model/contract"
import { type ViewRefused, ViewsClient } from "./api"
import { viewConversation } from "./conversation"
import { formRefusal } from "./form"
import {
  AskWithForm,
  CheckForm,
  type CheckedForm,
  FormRefused,
  MoveRefused,
  PlanIssues,
  type PlannedIssues,
  type PlannedRepo,
  PlannedView,
  PlanRepo,
  PlanView,
  RenderView,
  SendState,
  SetViewState,
  ShowForm,
  ShowIssues,
  ShowIssuesView,
  ShowRepo,
  ShowRepoView,
  TemplateRefused,
  ViewForbidden,
  ViewNotRendered,
  ViewStale,
  ViewUnavailable,
  WriteView,
} from "./flows"
import { readWritten, RENDERER_SYSTEM, rendererCorrection, rendererTask } from "./renderer"
import type { IssuesWrite, RepoWrite } from "./schema"

// What the views flows' steps run on (docs/features/views.md#the-flows): ChatApi's views routes (`ViewsClient`) and the
// renderer's seat (`RendererSeat`, the model endpoint's `renderer` role). An agent's call is a child execution of its
// answer's run, so its view goes to that answer's conversation (decision 0013 §1). Each step logs one line and counts
// one outcome; none carries a form's schema or values, a description, a module, its props or its state.

/** The renderer's model: the endpoint's `renderer` role, which an Admin sets (`admin/SetModel`). */
export class RendererSeat extends Context.Service<
  RendererSeat,
  { readonly model: Model.Model; readonly route: FlowEngineLike.RouteResolver; readonly maxTokens: number }
>()("@smthrs/mvp/views/RendererSeat") {
  /**
   * The `renderer` role of the model endpoint on `origin`, or `model` in its place: only the end-to-end tests' scripted
   * agent under the dev server (src/test/scriptedAgent.ts).
   */
  static readonly layer = (origin: string, model?: Model.Model, maxTokens = 8_000) =>
    Layer.effect(
      RendererSeat,
      Effect.gen(function* () {
        const url = `${origin}${MODEL_ROUTE}/renderer`
        return { model: model ?? (yield* ModelProxy.makeClient({ url })), route: { prepare: ModelProxy.prepare({ url }) }, maxTokens }
      }),
    )
}

/** Views the flows added, by `template` (`form`, `generated`) and `outcome`. */
export const shown = Metric.counter("smithers_views_shown", {
  description: "Views the agent's flows added, by template and outcome",
  incremental: true,
})

/** Renderer corrections: modules ChatApi refused and handed back. */
export const corrections = Metric.counter("smithers_renderer_corrections", {
  description: "Generated view modules the renderer was asked to correct",
  incremental: true,
})

/** Moves in generated views, by `outcome`. */
export const moves = Metric.counter("smithers_view_moves", {
  description: "Moves in generated views, by outcome",
  incremental: true,
})

/** The most corrections one view gets (decision 0004 §4). */
export const MAX_CORRECTIONS = 2

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

/** Where the view goes: an agent's call to its answer's conversation; anything else to the home conversation. */
const placeOf = Effect.map(FlowRuntime.FlowInstance, ({ executionId }) => {
  const requester = requesterOf(executionId)
  return requester !== executionId && isUuid(requester) ? { answerId: requester.toLowerCase() } : {}
})

/** What a refused request to ChatApi means to a step, and the outcome it is counted as. */
const failureOf = (error: ViewRefused) =>
  error.status === 401 || error.status === 403
    ? { error: new ViewForbidden(), outcome: "forbidden" as const }
    : { error: new ViewUnavailable(), outcome: "unavailable" as const }

const record = (counter: typeof shown, attributes: Record<string, string>, line: string) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(counter, attributes), 1),
    Effect.logInfo(line).pipe(Effect.annotateLogs({ ...attributes, feature: "views" })),
  )

/** `ui/form/check`: the form's schema renders fields and asks for no secret; a fresh id for the view. */
export const checkForm = (form: { readonly title: string; readonly schema: Readonly<Record<string, unknown>>; readonly submitLabel?: string | undefined }) =>
  Effect.gen(function* () {
    const refused = formRefusal(form.schema)
    if (refused !== undefined) {
      yield* record(shown, { template: "form", outcome: "refused", reason: refused }, "views.form")
      return yield* new FormRefused({ reason: refused })
    }
    return {
      viewId: crypto.randomUUID(),
      title: form.title,
      schema: form.schema,
      submitLabel: form.submitLabel ?? "Send",
    } satisfies CheckedForm
  }).pipe(Effect.withSpan("views.form.check"))

/** `ui/form/show`: adds the form through ChatApi. */
export const showForm = (form: CheckedForm) =>
  Effect.gen(function* () {
    const added = yield* (yield* ViewsClient).add({
      id: form.viewId,
      template: "form",
      props: { title: form.title, schema: form.schema, submitLabel: form.submitLabel },
      ...(yield* placeOf),
    }).pipe(Effect.result)
    if (added._tag === "Failure") {
      if (added.failure.status === 400) {
        yield* record(shown, { template: "form", outcome: "refused" }, "views.form")
        return yield* new FormRefused({ reason: "no_fields" })
      }
      const failed = failureOf(added.failure)
      yield* record(shown, { template: "form", outcome: failed.outcome }, "views.form")
      return yield* Effect.fail(failed.error)
    }
    yield* record(shown, { template: "form", outcome: "shown" }, "views.form")
    return { viewId: form.viewId, shown: "form" as const }
  }).pipe(Effect.withSpan("views.form.show"))

/** `ui/render/plan`: a fresh id for the view, and where it shows first (`inline` unless asked). */
export const planView = (task: { readonly description: string; readonly size?: "inline" | "full" | undefined; readonly data?: Readonly<Record<string, unknown>> | undefined }) =>
  Effect.succeed({
    viewId: crypto.randomUUID(),
    description: task.description,
    size: task.size ?? "inline",
    ...(task.data === undefined ? {} : { data: task.data }),
  } satisfies PlannedView)

/** The renderer's failure as the step's: no model for the role (`no_route`) is `unconfigured`. */
const modelFailure = (error: unknown) =>
  new ViewNotRendered({
    reason: error instanceof ModelError.ModelError && error.code === "no_route" ? "unconfigured" : "unavailable",
  })

/**
 * `ui/render/write`: the renderer writes the module (one sealed `ModelStep` per attempt), and ChatApi checks, renders and
 * keeps it. A module ChatApi refuses (`422`), or a reply with no module, goes back to the renderer with what went wrong,
 * at most {@link MAX_CORRECTIONS} times; then the step fails `ViewNotRendered`.
 */
export const writeView = (planned: PlannedView) =>
  Effect.gen(function* () {
    const seat = yield* RendererSeat
    const client = yield* ViewsClient
    const place = yield* placeOf
    const messages: Array<ModelRequest.Message> = [ModelRequest.Message.user(rendererTask(planned))]
    for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
      const result = yield* ModelStep.run({
        name: `ui/render/model/${attempt}`,
        ...seat,
        request: ModelRequest.ModelRequest.make({
          modelId: "renderer",
          tools: [],
          // The allowance includes reasoning: 4,096 tokens yielded empty replies in the live board eval.
          params: ModelRequest.GenerationParams.make({ maxTokens: seat.maxTokens }),
          system: [{ type: "text", text: RENDERER_SYSTEM }],
          messages: [...messages],
        }),
      }).pipe(Effect.mapError(modelFailure))
      if (result.error) return yield* modelFailure(result.error)
      const reply = ModelEvent.settledMessage(result.events).message.content
        .filter((part) => part.type === "text").map((part) => part.text).join("")
      messages.push(ModelRequest.Message.assistant(reply))
      const written = readWritten(reply)
      // What went wrong, for the correction: the reply itself, or ChatApi's check or render of its module.
      let problem: string
      if (typeof written === "string") problem = written
      else {
        const added = yield* client.add({
          id: planned.viewId,
          template: "generated",
          title: written.title,
          size: planned.size,
          code: written.code,
          props: planned.data ?? {},
          state: written.state,
          ...place,
        }).pipe(
          Effect.map((view) => ({ _tag: "Added" as const, interactions: view.interactions ?? {} })),
          Effect.catch((error) =>
            error.status === 422 && error.detail !== undefined
              ? Effect.succeed({ _tag: "NotRendered" as const, detail: error.detail })
              : Effect.flatMap(
                record(shown, { template: "generated", outcome: failureOf(error).outcome }, "views.render"),
                () => Effect.fail(failureOf(error).error),
              )
          ),
        )
        if (added._tag === "Added") {
          yield* record(shown, { template: "generated", outcome: "shown", corrections: String(attempt) }, "views.render")
          return {
            viewId: planned.viewId,
            title: written.title,
            size: planned.size,
            revision: 0,
            interactions: added.interactions,
          }
        }
        problem = added.detail
      }
      if (attempt < MAX_CORRECTIONS) {
        yield* Metric.update(corrections, 1)
        messages.push(ModelRequest.Message.user(rendererCorrection(problem)))
      }
    }
    yield* record(shown, { template: "generated", outcome: "not_rendered" }, "views.render")
    return yield* new ViewNotRendered({ reason: "invalid" })
  }).pipe(Effect.withSpan("views.render.write", { attributes: { "smithers.view.size": planned.size } }))

/** `view/set-state/send`: ChatApi makes the move; the view's new revision. */
export const sendState = (move: {
  readonly viewId: string
  readonly revision: number
  readonly event: { readonly name: string; readonly arg?: string }
}) =>
  Effect.gen(function* () {
    // The move's id is its execution's, so every retry of it, after a crash too, is the same move to ChatApi.
    const { executionId } = yield* FlowRuntime.FlowInstance
    const changed = yield* (yield* ViewsClient).setState(move.viewId.toLowerCase(), {
      moveId: executionId,
      revision: move.revision,
      event: move.event,
    }).pipe(Effect.result)
    if (changed._tag === "Success") {
      yield* record(moves, { outcome: "moved" }, "views.move")
      return { viewId: move.viewId, revision: changed.success }
    }
    const error = changed.failure
    if (error.status === 409 && error.revision !== undefined) {
      yield* record(moves, { outcome: "stale" }, "views.move")
      return yield* new ViewStale({ revision: error.revision })
    }
    if (error.status === 400 || error.status === 404 || error.status === 422) {
      yield* record(moves, { outcome: "refused" }, "views.move")
      return yield* new MoveRefused()
    }
    const failed = failureOf(error)
    yield* record(moves, { outcome: failed.outcome }, "views.move")
    return yield* Effect.fail(failed.error)
  }).pipe(Effect.withSpan("views.move"))

/** `ui/repo/plan` and `ui/issues/plan`: a fresh id for the view. */
export const planTemplate = <A extends object>(input: A) => Effect.sync(() => ({ viewId: crypto.randomUUID(), ...input }))

/**
 * `ui/repo/show` and `ui/issues/show`: adds the view through ChatApi, to the conversation the running execution names
 * (an agent's call to its answer's, a person's to the one their tab showed). A refusal of its id is final; a refused
 * person is `ViewForbidden`; anything else ChatApi couldn't take is tried again.
 */
const showTemplate = (
  write: Pick<RepoWrite, "id" | "template" | "props"> | Pick<IssuesWrite, "id" | "template" | "props">,
  conversationId: string | undefined,
) =>
  Effect.gen(function* () {
    const { id: viewId, template } = write
    const added = yield* (yield* ViewsClient).add({ ...write, ...(yield* viewConversation(conversationId)) }).pipe(
      Effect.result,
    )
    if (added._tag === "Failure") {
      if (added.failure.status === 400 || added.failure.status === 404 || added.failure.status === 409) {
        yield* record(shown, { template, outcome: "refused" }, "views.template")
        return yield* new TemplateRefused()
      }
      const failed = failureOf(added.failure)
      yield* record(shown, { template, outcome: failed.outcome }, "views.template")
      return yield* Effect.fail(failed.error)
    }
    yield* record(shown, { template, outcome: "shown" }, "views.template")
    return { viewId, shown: template }
  }).pipe(Effect.withSpan("views.template.show", { attributes: { template: write.template } }))

/** `ui/repo/show`: the repository's view, with what it opens. */
export const showRepo = ({ viewId, conversationId, ...props }: PlannedRepo) =>
  showTemplate({ id: viewId, template: "repo", props }, conversationId)

/** `ui/issues/show`: the repository's issues view. */
export const showIssues = ({ viewId, conversationId, ...props }: PlannedIssues) =>
  showTemplate({ id: viewId, template: "issues", props }, conversationId)

/**
 * Registers `ui/form`, `ui/render`, `view/set-state`, `ui/repo` and `ui/issues` with their steps, over `ViewsClient` and
 * `RendererSeat`.
 */
export const registration = Layer.mergeAll(
  Interpreter.layerWithImplementations(AskWithForm, Layer.mergeAll(CheckForm.toLayer(checkForm), ShowForm.toLayer(showForm))),
  Interpreter.layerWithImplementations(
    RenderView,
    Layer.mergeAll(PlanView.toLayer(planView), WriteView.toLayer(writeView)),
  ),
  Interpreter.layerWithImplementations(SetViewState, SendState.toLayer(sendState)),
  Interpreter.layerWithImplementations(
    ShowRepo,
    Layer.mergeAll(PlanRepo.toLayer(planTemplate), ShowRepoView.toLayer(showRepo)),
  ),
  Interpreter.layerWithImplementations(
    ShowIssues,
    Layer.mergeAll(PlanIssues.toLayer(planTemplate), ShowIssuesView.toLayer(showIssues)),
  ),
)
