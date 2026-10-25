// Your conversations' contract between the browser, ChatApi and the tests (decision 0013 decision 2,
// docs/features/conversations.md): one conversation per branch, a person's own list of them, and archiving one from
// that list. Nothing here imports a library, so every side can.

/**
 * `POST` `{ conversationId | answerId, archived, at }` archives a conversation for the signed-in person, or brings it
 * back (`conversation/archive`): the one named, or, for the agent, the one its answer `answerId` is in. `at` is when the
 * act happened, in milliseconds since the epoch: the latest act wins, whatever order acts arrive in, and opening the
 * branch is an act too.
 */
export const ARCHIVE_ROUTE = "/api/conversations/archive"

/** `GET`: Electric's `conversation_people`, only the signed-in person's rows: their conversations, archived or not. */
export const MY_CONVERSATIONS_SHAPE_ROUTE = "/api/shapes/my-conversations"

/** The Postgres table: who has which conversation in their list, and whether they archived it. */
export const CONVERSATION_PEOPLE_TABLE = "conversation_people"

/** The largest `POST /api/conversations/archive` body. */
export const MAX_ARCHIVE_BODY_BYTES = 256

/** How long one archive request may take, the whole exchange included. */
export const ARCHIVE_WITHIN = "15 seconds"

/** Where your conversations are listed. */
export const CONVERSATIONS_HREF = "/app/conversations"

/** What a new conversation's branch is called when the person names none: this, then six hex digits. */
export const NEW_BRANCH_PREFIX = "conversation-"

/**
 * A new conversation's branch name from `uuid`, a version 5 UUID of its run: the same run always names the same
 * branch, so a step tried again makes no second one.
 */
export const newBranchName = (uuid: string): string =>
  `${NEW_BRANCH_PREFIX}${uuid.replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 6).padEnd(6, "0")}`

/** The app path of branch `branch` of `owner/repo`: its page, with its conversation. */
export const branchPath = (repo: string, branch: string): string =>
  `/${repo}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`

/**
 * What your conversations record in the browser (docs/observability.md#browser), by name, and the attributes they
 * carry. No attribute carries a branch's name, a repository or what was searched.
 */
export const CONVERSATIONS_TELEMETRY = {
  records: [
    "conversations.shape.sync",
    "conversations.list",
    "smithers_conversation_shape_transitions",
    "smithers_conversation_list_updates",
    "conversation.archive",
    "conversation.archive.post",
    "conversation.new",
    "conversations.archive",
    "conversations.dropped",
    "smithers_web_conversation_archives",
    "smithers_web_conversation_news",
    "smithers_web_conversation_archives_dropped",
  ],
  fields: ["outcome", "status", "archived", "door", "durationMs", "conversationId", "reason", "phase", "syncedRows", "pendingRows", "listedRows", "loaded"],
} as const
