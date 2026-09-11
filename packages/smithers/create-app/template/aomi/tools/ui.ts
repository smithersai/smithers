/**
 * The UI tool: two bindings that put a card in the transcript.
 *
 * `ui/pane` renders a React pane the app registered by file location
 * (`app/panes/<name>.tsx`); `ui/html` renders a block of HTML the model wrote
 * itself. Both return only a `cardId`, because the card itself travels to the
 * browser on the turn stream (`TurnFrame`), not through the cell's return
 * value.
 *
 * Neither binding renders anything. They hand a card to the {@link CardSink}
 * the Worker provides for the turn, and the Worker is what appends it to the
 * session and emits the `card` frame. A composition with no sink gets
 * {@link layerNoop}, which collects into an array a test can read.
 *
 * A pane name is checked against {@link PaneNames} before the card is built. A
 * wrong name is the model's most likely mistake here, and a rejection that
 * lists the registered panes costs one frame; a card referencing a pane the
 * shell cannot resolve costs the whole answer.
 */
import * as Flow from "@smthrs/core/Flow"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import type { AppCard } from "@smthrs/create-app/ui"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The one failure a UI call reports to a cell.
 *
 * Each binding explicitly opts its message into the public failure with
 * `publicError`. Write it for the model: what was wrong and what to do next.
 */
export class UiError extends Schema.TaggedError<UiError>()("aomi/tools/UiError", {
  message: Schema.String
}) {}

// ---------------------------------------------------------------------------
// CardSink
// ---------------------------------------------------------------------------

/** Where a rendered card goes. The Worker binds one per turn. */
export interface CardSinkService {
  readonly emit: (card: AppCard) => Effect.Effect<void>
  /** Replace the full card by id, inserting it if absent. */
  readonly update: (card: AppCard) => Effect.Effect<void>
}

/** Service tag for the turn's card sink. */
export class CardSink extends Context.Service<CardSink, CardSinkService>()("aomi/tools/CardSink") {}

/** A sink that appends emissions and replaces updates by id, inserting absent ids. */
export const makeCollecting = (collected: Array<AppCard>): CardSinkService =>
  CardSink.of({
    emit: (card) => Effect.sync(() => void collected.push(card)),
    update: (card) =>
      Effect.sync(() => {
        const index = collected.findIndex((entry) => entry.id === card.id)
        if (index === -1) collected.push(card)
        else collected[index] = card
      })
  })

/** A sink that drops every card. */
export const makeNoop = (overrides: Partial<CardSinkService> = {}): CardSinkService =>
  CardSink.of({ emit: () => Effect.void, update: () => Effect.void, ...overrides })

/**
 * Provides an in-memory sink over a fresh array.
 *
 * The array is created when the layer is built, so a caller that wants to read
 * the cards back builds one itself and uses `Layer.succeed(CardSink)(
 * makeCollecting(cards))` instead.
 */
export const layerNoop = (overrides: Partial<CardSinkService> = {}): Layer.Layer<CardSink> =>
  Layer.sync(CardSink)(() => makeNoop(overrides))

/** Provides a sink that collects into `collected`. */
export const layerCollecting = (collected: Array<AppCard>): Layer.Layer<CardSink> =>
  Layer.succeed(CardSink)(makeCollecting(collected))

// ---------------------------------------------------------------------------
// PaneNames
// ---------------------------------------------------------------------------

/**
 * One registered pane.
 *
 * `fullscreen` rides along because `PaneCard` carries it and only the pane's
 * own definition knows it; asking the registry twice would let the card and
 * the component disagree.
 */
export interface RegisteredPane {
  readonly name: string
  readonly fullscreen: boolean
}

/** The panes routes.gen.ts registered for this app. */
export interface PaneNamesService {
  readonly list: () => Effect.Effect<ReadonlyArray<RegisteredPane>>
}

/** Service tag for the registered pane list. */
export class PaneNames extends Context.Service<PaneNames, PaneNamesService>()("aomi/tools/PaneNames") {}

/** A registry over a fixed pane list. */
export const makePanes = (panes: ReadonlyArray<RegisteredPane>): PaneNamesService =>
  PaneNames.of({ list: () => Effect.succeed(panes) })

/** Provides a registry over a fixed pane list. */
export const layerPanes = (panes: ReadonlyArray<RegisteredPane>): Layer.Layer<PaneNames> =>
  Layer.succeed(PaneNames)(makePanes(panes))

/** Provides an empty registry: every `ui/pane` call is refused by name. */
export const layerNoPanes = (): Layer.Layer<PaneNames> => layerPanes([])

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const PaneInput = Schema.Struct({
  cardId: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Omit to create a card. Supply a returned cardId to replace the full card; inserts if absent. Props are replaced, not merged, and an omitted title clears the previous heading."
    })
  ),
  name: Schema.String.annotate({ description: "Registered pane name, as listed in the failure message when wrong" }),
  props: Schema.Unknown.annotate({ description: "Props object the pane's own schema decodes" }),
  title: Schema.optionalKey(Schema.String.annotate({ description: "Card heading; the pane's own title is used when omitted" }))
})
export type PaneInput = typeof PaneInput.Type

export const PaneOutput = Schema.Struct({
  cardId: Schema.String.annotate({
    description: "Id of the card; pass as cardId to ui/pane to replace it with a registered pane"
  })
})
export type PaneOutput = typeof PaneOutput.Type

export const HtmlInput = Schema.Struct({
  html: Schema.String.annotate({ description: "HTML fragment; the shell renders it in a scriptless sandboxed frame with no network" }),
  title: Schema.optionalKey(Schema.String.annotate({ description: "Card heading" }))
})
export type HtmlInput = typeof HtmlInput.Type

export const HtmlOutput = PaneOutput
export type HtmlOutput = typeof HtmlOutput.Type

// ---------------------------------------------------------------------------
// Flow declarations
// ---------------------------------------------------------------------------

const paneFlow = Flow.make({
  name: "ui/pane",
  description:
    "Render a registered pane as a card in the transcript, or replace a card by supplying cardId. Prefer this over prose whenever a pane fits the data; a wrong name is refused with the list of registered panes.",
  input: PaneInput,
  output: PaneOutput,
  capabilities: [],
  effects: undefined
})

const htmlFlow = Flow.make({
  name: "ui/html",
  description:
    "Render an HTML fragment as a card in the transcript. Use it only when no registered pane fits; a pane is always the better answer.",
  input: HtmlInput,
  output: HtmlOutput,
  capabilities: [],
  effects: undefined
})

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * A card id that is stable across a replay.
 *
 * The cell re-executes from the top after a crash or a permission park, so a
 * random id would emit a second card for the same call. The execution session,
 * frame and call ordinal stay fixed on replay; the session separates runs.
 */
const cardIdOf = (session: string, frame: number, ordinal: number): string => `card-${session}-${frame}-${ordinal}`

const unknownPane = (name: string, panes: ReadonlyArray<RegisteredPane>): UiError =>
  new UiError({
    message: panes.length === 0
      ? `No panes are registered in this app, so "${name}" cannot be rendered. Answer in prose, or call ui/html.`
      : `"${name}" is not a registered pane. Registered panes: ${
        panes.map((pane) => pane.name).join(", ")
      }. Reissue ui/pane with one of those names.`
  })

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/** The UI flows, bound to the sink and pane registry the host built. */
export const uiSource = (services: Context.Context<CardSink | PaneNames>): FlowBinding.Source =>
  FlowBinding.source("ui", [
    FlowBinding.provide(
      FlowBinding.make({
        flow: paneFlow,
        publicError: (error: UiError) => error.message,
        handler: (input, call) =>
          Effect.gen(function*() {
            const registry = yield* PaneNames
            const panes = yield* registry.list()
            const pane = panes.find((entry) => entry.name === input.name)
            if (pane === undefined) return yield* Effect.fail(unknownPane(input.name, panes))
            const sink = yield* CardSink
            const cardId = input.cardId ?? cardIdOf(call.identity.session, call.identity.frame, call.identity.ordinal)
            const card: AppCard = {
              kind: "pane",
              id: cardId,
              name: pane.name,
              props: input.props,
              fullscreen: pane.fullscreen,
              ...(input.title === undefined ? {} : { title: input.title })
            }
            if (input.cardId === undefined) yield* sink.emit(card)
            else yield* sink.update(card)
            return { cardId }
          })
      }),
      services
    ),
    FlowBinding.provide(
      FlowBinding.make({
        flow: htmlFlow,
        publicError: (error: UiError) => error.message,
        handler: (input, call) =>
          Effect.gen(function*() {
            const sink = yield* CardSink
            const cardId = cardIdOf(call.identity.session, call.identity.frame, call.identity.ordinal)
            yield* sink.emit({
              kind: "html",
              id: cardId,
              html: input.html,
              ...(input.title === undefined ? {} : { title: input.title })
            })
            return { cardId }
          })
      }),
      services
    )
  ])

/**
 * The source TOOLS.ts composes today: a sink that drops cards and an empty
 * pane registry. The Worker builds its own per turn with
 * `uiSource(Context.merge(...))` so cards reach the session.
 *
 * TODO(milestone-3): worker/turn.ts passes the session sink and the pane list
 * from routes.gen.ts here.
 */
export const ui: FlowBinding.Source = uiSource(
  Context.add(Context.make(CardSink, makeNoop()), PaneNames, makePanes([]))
)
