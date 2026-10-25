// The conversation's views contract (docs/features/web-pages.md#the-views-table, decision 0004 §8): the one home of the
// values the tab, the engine worker, ChatApi and the tests share. Nothing here imports a library, so every side can.

/** ChatApi's route that adds a view to the conversation: `POST`. */
export const VIEWS_ROUTE = "/api/views"

/** ChatApi's Electric shape proxy for `views`: `GET`. */
export const VIEWS_SHAPE_ROUTE = "/api/shapes/views"

/** The Postgres table the shape proxy serves. */
export const VIEWS_TABLE = "views"

/**
 * The templates a view renders with (decision 0004 §3):
 * - `webpage`: an outside page in a sandboxed frame, with its origin and an "Open in new tab" link above it;
 * - `link`: a card with an outside page's origin and an Open button, which opens it in a new tab;
 * - `docs`: a repository docs page whose Markdown the server reads from its index;
 * - `form`: the agent's question as a form (`ui/form`), our own React, whose submission is the person's next question;
 * - `generated`: a view the renderer wrote (`ui/render`), which only ChatApi's presentation realm runs, shown as HTML
 *   in a sandboxed frame (docs/features/views.md);
 * - `repo`: a repository's own view (`ui/repo`), our React over the repository the row names, small in the message, and
 *   full screen at the repository's own URL;
 * - `issues`: a repository's issues view (`ui/issues`), likewise, full screen at its issues page.
 */
export const VIEW_TEMPLATES = ["webpage", "link", "docs", "form", "generated", "repo", "issues"] as const

/** The templates that show one of the app's own views of a repository (decision 0004 §3): no model call, no frame. */
export const APP_TEMPLATES = ["repo", "issues"] as const

/** One of {@link APP_TEMPLATES}. */
export type AppTemplate = (typeof APP_TEMPLATES)[number]

/** The templates that show an outside page. */
export const PAGE_TEMPLATES = ["webpage", "link", "docs"] as const

/** Where a view shows first: in the message, or at its full size. */
export const VIEW_SIZES = ["inline", "full"] as const

/** One of {@link VIEW_TEMPLATES}. */
export type ViewTemplate = (typeof VIEW_TEMPLATES)[number]

/** The largest `POST /api/views` body for a page or a form: 8 KiB. */
export const MAX_VIEW_BODY_BYTES = 8 * 1024

/** The largest `POST /api/views` body for a generated view, whose module may be 64 KiB: 96 KiB. */
export const MAX_GENERATED_BODY_BYTES = 96 * 1024

/** The longest form or view title. */
export const MAX_VIEW_TITLE = 120

/** The longest submit label: it is the submission's question text too. */
export const MAX_SUBMIT_LABEL = 40

/** The largest form schema, or generated view's props or state, as JSON: 16 KiB, as `@smthrs/views` bounds state. */
export const MAX_VIEW_JSON_BYTES = 16 * 1024

/** The largest HTML a generated view keeps: 256 KiB, the `views.html` bound (0052_agent_views). */
export const MAX_VIEW_HTML_BYTES = 256 * 1024

/** ChatApi's route that changes a generated view's state by one declared event: `POST /api/views/<id>/state`. */
export const viewStateRoute = (viewId: string): string => `${VIEWS_ROUTE}/${viewId}/state`

/** The event a form's submission names as its question's source. */
export const SUBMIT_EVENT = "submit"

/** The route that shows one view full screen (decision 0004 §6): `/app/views/<id>`. */
export const viewPath = (viewId: string): string => `/app/views/${viewId}`

/** The link from a view in the conversation to its full size. */
export const FULL_SCREEN = "Full screen"

/** The full-size route's way back. */
export const BACK_TO_CHAT = "Back to chat"

/**
 * What the views flows record that the relay keeps (src/telemetry.ts): their log lines, spans and counts, by template,
 * outcome and corrections, never a schema, values, a description, a module, its props, state or HTML.
 */
export const VIEWS_TELEMETRY = {
  records: [
    "views.form",
    "views.render",
    "views.move",
    "views.form.check",
    "views.form.show",
    "views.render.write",
    "views.move.dispatch",
    "views.template",
    "views.template.show",
    "views.minimize",
    "smithers_views_shown",
    "smithers_renderer_corrections",
    "smithers_view_moves",
    "smithers_views_minimized",
  ],
  fields: ["template", "outcome", "reason", "corrections", "smithers.view.size", "returned"],
} as const
