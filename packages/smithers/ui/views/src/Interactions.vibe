/**
 * The events a generated view declares, and the `data-event` attribute that
 * names one on an element.
 *
 * A view never runs code in the browser. Instead it marks a button or a form
 * with `data-event="name"` or `data-event="name:arg"`, and declares each name
 * in its module's `interactions` export:
 *
 * - a `state` event runs the view's `reduce` and renders again, with no model
 *   call;
 * - a `message` event becomes a question from the person, carrying the
 *   element's form values as data.
 *
 * An event whose name the view did not declare is refused, wherever it comes
 * from.
 *
 * @since 0.1.0
 */

import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * The most interactions one view may declare.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxDeclared = 32

/**
 * The longest `arg` an event may carry, in UTF-16 code units.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxArgLength = 256

/**
 * The longest label a `message` interaction may carry.
 *
 * @category constants
 * @since 0.1.0
 */
export const maxLabelLength = 80

const namePattern = /^[a-z][A-Za-z0-9_-]{0,31}$/

/**
 * An interaction's name: a lowercase letter, then up to 31 letters, digits,
 * `_` or `-`. It never contains `:`, which separates the name from its
 * argument in a `data-event` attribute.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Name = Schema.String.check(Schema.isPattern(namePattern))

/**
 * An interaction's name.
 *
 * @category models
 * @since 0.1.0
 */
export type Name = typeof Name.Type

/**
 * An event that changes the view's own state: the parent runs `reduce` and
 * renders again. It never calls a model.
 *
 * @category schemas
 * @since 0.1.0
 */
export const StateInteraction = Schema.Struct({ kind: Schema.Literal("state") })

/**
 * An event that becomes a question from the person. `label` is the question's
 * text, such as the label of the button that sent it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const MessageInteraction = Schema.Struct({
  kind: Schema.Literal("message"),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxLabelLength))
})

/**
 * One declared interaction.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Interaction = Schema.Union([StateInteraction, MessageInteraction])

/**
 * One declared interaction.
 *
 * @category models
 * @since 0.1.0
 */
export type Interaction = typeof Interaction.Type

/**
 * A view's `interactions` export: each event name it may send, and its kind.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Declared = Schema.Record(Schema.String, Interaction).check(
  Schema.isPropertyNames(Name),
  Schema.isMaxProperties(maxDeclared)
)

/**
 * A view's `interactions` export.
 *
 * @category models
 * @since 0.1.0
 */
export type Declared = typeof Declared.Type

/**
 * The argument a `data-event="name:arg"` attribute carries.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Arg = Schema.String.check(Schema.isMaxLength(maxArgLength))

/**
 * One event a view sent: the declared name and the optional argument from its
 * `data-event` attribute. `reduce` receives exactly this.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Event = Schema.Struct({ name: Name, arg: Schema.optionalKey(Arg) })

/**
 * One event a view sent.
 *
 * @category models
 * @since 0.1.0
 */
export type Event = typeof Event.Type

const decodeEvent = Schema.decodeUnknownOption(Event)

/**
 * Reads a `data-event` attribute: `"name"` or `"name:arg"`. Everything after
 * the first `:` is the argument. A malformed name or an overlong argument is
 * `None`.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parse = (attribute: string): Option.Option<Event> => {
  const at = attribute.indexOf(":")
  return at === -1
    ? decodeEvent({ name: attribute })
    : decodeEvent({ name: attribute.slice(0, at), arg: attribute.slice(at + 1) })
}

/**
 * Writes the `data-event` attribute for an event: the inverse of {@link parse}.
 *
 * @category parsing
 * @since 0.1.0
 */
export const format = (event: Event): string => event.arg === undefined ? event.name : `${event.name}:${event.arg}`

/**
 * The declared interaction an event names, or `None` when the view did not
 * declare it. Own properties only, so `constructor` or `__proto__` never
 * match.
 *
 * @category lookups
 * @since 0.1.0
 */
export const lookup = (declared: Declared, name: string): Option.Option<Interaction> =>
  name !== "constructor" && name !== "__proto__" && Object.hasOwn(declared, name)
    ? Option.some(declared[name]!)
    : Option.none()
