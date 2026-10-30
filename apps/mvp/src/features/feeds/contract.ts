import { isRepository, REPOS_ROUTE } from "../repo/contract"

// Repository feeds' contract between the browser, ChatApi and an outside collector (decision 0126,
// docs/features/feeds.md): the routes, the tables, the limits and the refusals. Nothing here imports a library, so every
// side can.

/** The routes' last segments: `/api/repos/<owner>/<name>/feeds` and `.../feeds/answers`. */
export const FEEDS_SEGMENT = "feeds"
export const ANSWERS_SEGMENT = "answers"

/** `GET`: Electric's `feed_documents` of one repository (`?repo=<owner>/<name>[&name=<document>]`). */
export const FEEDS_SHAPE_ROUTE = "/api/shapes/feeds"

/** The Postgres tables: one row per document, one per answer. */
export const FEED_DOCUMENTS_TABLE = "feed_documents"
export const FEED_ANSWERS_TABLE = "feed_answers"

/** The columns a device syncs: all of them. */
export const FEED_DOCUMENT_COLUMNS = ["id", "repo", "name", "visibility", "body", "updated_at"] as const

/** The environment variable listing each repository's feed key's SHA-256: `owner/name=<hex>,...`. */
export const FEED_KEYS_VARIABLE = "FEED_KEYS"

/** Who a document syncs to: everyone, signed out included, or the repository's Maintainers and Admins in person. */
export const VISIBILITIES = ["public", "maintainers"] as const
export type Visibility = (typeof VISIBILITIES)[number]

/** The largest write, in bytes, and the largest document in it (its body as JSON). */
export const MAX_FEED_REQUEST_BYTES = 2 * 1024 * 1024
export const MAX_FEED_DOCUMENT_BYTES = 1024 * 1024

/** The most documents one write sets or deletes. */
export const MAX_FEED_DOCUMENTS = 200

/** The longest document name. */
export const MAX_FEED_NAME_LENGTH = 200

/**
 * A document's name: a first segment of lowercase letters, digits, `_`, `.` and `-`, then any number of `/` segments
 * that may hold capitals and `:` too (`lanes`, `transcript/lane-3`, `report/r2/Codex:astra`).
 */
const FEED_NAME = /^[a-z0-9_.-]+(\/[A-Za-z0-9_.:-]+)*$/

/** Whether `name` is a document name. */
export const isFeedName = (name: string): boolean => name.length <= MAX_FEED_NAME_LENGTH && FEED_NAME.test(name)

/** Whether a document is in its repository's index, which syncs eagerly: its name has no `/` (decision 0126 §5). */
export const isIndexName = (name: string): boolean => !name.includes("/")

/** A repository as feeds key it: `owner/name`, lowercased. */
export const feedRepo = (owner: string, name: string): string => `${owner}/${name}`.toLowerCase()

/** A document's id, its Electric key: `<repo>:<name>`. A repository has no `:`, so it is unique. */
export const feedDocumentId = (repo: string, name: string): string => `${repo}:${name}`

/** `repo` (`owner/name`) as a repository feeds key, or `undefined` when it isn't one. */
export const parseFeedRepo = (repo: string): string | undefined => {
  const [owner = "", name = "", ...rest] = repo.split("/")
  return rest.length === 0 && isRepository(owner, name) ? feedRepo(owner, name) : undefined
}

/** `POST`: the collector's write of a repository's documents. */
export const feedsRoute = (owner: string, name: string) =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${FEEDS_SEGMENT}`

/** `GET` (the collector, by key) and `POST` (a Maintainer in person): a repository's answers. */
export const feedAnswersRoute = (owner: string, name: string) => `${feedsRoute(owner, name)}/${ANSWERS_SEGMENT}`

/** A feeds route's repository and which route it is; `undefined` for any other path. */
export const parseFeedRoute = (
  path: string,
): { readonly owner: string; readonly name: string; readonly route: "documents" | "answers" } | undefined => {
  const match = /^\/api\/repos\/([^/]+)\/([^/]+)\/feeds(\/answers)?$/.exec(path)
  if (match === null) return undefined
  try {
    const owner = decodeURIComponent(match[1]!)
    const name = decodeURIComponent(match[2]!)
    if (!isRepository(owner, name)) return undefined
    return { owner, name, route: match[3] === undefined ? "documents" : "answers" }
    // expected: a path that does not decode names no repository
  } catch {
    return undefined
  }
}

/** The most answers one read answers. */
export const ANSWERS_MAX = 200

/** The largest answer body, in bytes, and its fields' longest. */
export const MAX_ANSWER_BODY_BYTES = 32 * 1024
export const MAX_ANSWER_ITEM_LENGTH = 200
export const MAX_ANSWER_CHOICE_LENGTH = 200
export const MAX_ANSWER_TEXT_LENGTH = 8_000

/** How long one ChatApi exchange of `feed/answer` may take, the whole of it. */
export const FEED_ANSWER_WITHIN = "15 seconds"

/** Why ChatApi refused a feeds request: its body's `code`. */
export const REFUSALS = [
  "authentication",
  "forbidden",
  "person_only",
  "invalid",
  "invalid_name",
  "too_large",
  "conflict",
  "off",
  "unavailable",
] as const
export type Refusal = (typeof REFUSALS)[number]

/** `core/feeds` and `core/feed`'s row, as plugins read it (src/plugins/facts.ts). */
export const FEED_ROW = {
  type: "object",
  properties: {
    id: { type: "string" },
    repo: { type: "string" },
    name: { type: "string" },
    visibility: { type: "string", enum: [...VISIBILITIES] },
    body: {},
    updatedAt: { type: "string" },
  },
  required: ["id", "repo", "name", "visibility", "body", "updatedAt"],
  additionalProperties: false,
} as const

/**
 * What repository feeds record in the browser, by name, and the fields they carry (docs/observability.md#repository-feeds).
 * None carries a document's name or body, an answer's words, a login or a key.
 */
export const FEEDS_TELEMETRY = {
  records: ["feed.answer", "smithers_web_feed_answers", "feed.answer.send", "smithers_web_feed_documents"],
  fields: ["outcome", "status", "code"],
} as const
