// Co-editing (decision 0013 §4, docs/features/coedit.md): every input two people see at once is one text they edit
// together, with each other's cursors: a conversation's prompt, a file of a branch's working copy, and the answer box
// of a run that needs its person. The contract between the browser, ChatApi and the tests. Nothing here imports a
// library, so every side can. The text itself is `@smthrs/sync`'s `SharedText`; its cursors ride a presence room.

/** `POST <route>/<text id>` `{ scope, id, update, seed? }` adds one update to a text. */
export const TEXTS_ROUTE = "/api/texts"

/** A text's own route. */
export const textRoute = (textId: string): string => `${TEXTS_ROUTE}/${textId}`

/** `GET` with `Upgrade: websocket` and the text's scope as its query: the text's cursors (a presence room). */
export const textRoomRoute = (textId: string): string => `${TEXTS_ROUTE}/${textId}/room`

/** ChatApi's Electric shape proxy for one text's updates: `GET ?text=<text id>&` and the text's scope as its query. */
export const TEXTS_SHAPE_ROUTE = "/api/shapes/texts"

/** The Postgres table of the updates (db/migrations/0026_text_updates.ts). */
export const TEXT_UPDATES_TABLE = "text_updates"

/** The columns a device syncs: the update's id and the update, as base64 (`data`). */
export const TEXT_UPDATE_COLUMNS = ["id", "data"] as const

/** The home conversation, as a scope names it: ChatApi knows which it is. */
export const HOME = "home"

/**
 * Who may see and edit a text:
 * - a conversation's (`home` for the home conversation): everyone who may view its branch sees it, and everyone who
 *   may edit the branch edits it;
 * - a run's: only the person who started it, the one it asks.
 */
export type TextScope = { readonly conversation: string } | { readonly run: string }

/** A scope as a query string's parameters, and as the body's `scope`. */
export const scopeParams = (scope: TextScope): Record<string, string> =>
  "conversation" in scope ? { conversation: scope.conversation } : { run: scope.run }

/**
 * What a text is: a conversation's prompt, a file of a conversation's branch, or the answer box of a run's question
 * (`version`, as the run counts its questions).
 */
export type TextOf =
  | { readonly kind: "prompt"; readonly conversation: string }
  | { readonly kind: "file"; readonly conversation: string; readonly path: string }
  | { readonly kind: "answer"; readonly run: string; readonly version: number }

/** The scope a text's access follows. */
export const scopeOf = (text: TextOf): TextScope =>
  text.kind === "answer" ? { run: text.run } : { conversation: text.conversation }

/**
 * The namespace a text's id is derived in (RFC 9562 version 5, `@smthrs/crypto`'s `Uuid.v5`) from `textName`, so
 * every device names one text alike.
 */
export const TEXT_NAMESPACE = "8f3c1d2e-6a4b-4c7d-9e21-5b0f7a3c9d64"

/** The name `TEXT_NAMESPACE` derives a text's id from. */
export const textName = (text: TextOf): string =>
  text.kind === "prompt"
    ? `conversation/${text.conversation}/prompt`
    : text.kind === "file"
    ? `conversation/${text.conversation}/file/${text.path}`
    : `run/${text.run}/answer/${text.version}`

/**
 * The largest `POST` body: a seed of the largest file the sandbox reads (`SandboxTools.limits.fileBytes`, 1 MiB), as
 * base64 in JSON.
 */
export const MAX_TEXT_BODY_BYTES = 2 * 1024 * 1024

/** The longest `update`, in base64 characters: the body's limit. */
export const MAX_UPDATE_LENGTH = MAX_TEXT_BODY_BYTES

/**
 * Why ChatApi refused an update for good: a bad body (`invalid`), signed out (`authentication`), allowed only to view
 * (`view_only`), not allowed at all (`forbidden`), or no such conversation or run (`not_found`).
 */
export const TEXT_REFUSALS = ["invalid", "authentication", "view_only", "forbidden", "not_found"] as const
export type TextRefusal = (typeof TEXT_REFUSALS)[number]

/**
 * What co-editing records in the browser (docs/observability.md#browser): each text opened by kind, each update sent
 * by outcome, a file's seed, an update that isn't one, and saves by outcome. Never a text, an update, a path or a
 * cursor.
 */
export const COEDIT_TELEMETRY = {
  records: [
    "coedit.open",
    "coedit.send",
    "coedit.seed",
    "coedit.apply",
    "coedit.save",
    "coedit.admit",
    "smithers_web_coedit_opens",
    "smithers_web_coedit_sends",
    "smithers_web_coedit_saves",
  ],
  fields: ["kind", "outcome", "status", "bytes", "textId", "durationMs", "reason", "errorCode", "feature"],
} as const
