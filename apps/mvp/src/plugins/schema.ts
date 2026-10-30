import { Schema } from "effect"

// The plugin host's state on this tab (decision 0017): which plugin view is shown, and per view what the host's action
// strip holds. Plugin code never writes it; it asks the host through `PluginHost.select` and `propose`.

/** The one `Shown` row's key. */
export const SHOWN = "shown"

/** The plugin view this tab shows full screen, `null` for none. */
export const Shown = Schema.Struct({ id: Schema.Literal(SHOWN), view: Schema.NullOr(Schema.String) })
export type Shown = typeof Shown.Type

/**
 * One view's strip, keyed by the view's id: the item the view selected (its query, the `params` the query was asked
 * with, and its key), whether a press is on its way (`sending`), and whether the last one failed (`failed`, cleared by
 * the next press or another item).
 */
export const ViewState = Schema.Struct({
  id: Schema.String,
  query: Schema.NullOr(Schema.String),
  params: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  item: Schema.NullOr(Schema.String),
  sending: Schema.Boolean,
  failed: Schema.Boolean,
})
export type ViewState = typeof ViewState.Type

/** A view's strip before anything happened on it. */
export const fresh = (id: string): ViewState => ({
  id,
  query: null,
  params: null,
  item: null,
  sending: false,
  failed: false,
})

/**
 * The strip's note for one item of one view, kept on the device so a reload keeps it (src/device/registry.ts): keyed by
 * `draftKey`, so a note belongs to the item it was written for and never rides with another.
 */
export const Draft = Schema.Struct({ id: Schema.String, text: Schema.String })
export type Draft = typeof Draft.Type

/** The key of view `view`'s note for item `item`. */
export const draftKey = (view: string, item: string): string => `${view}\u0000${item}`
