import { Schema } from "effect"
import {
  MAX_ANSWER_CHOICE_LENGTH,
  MAX_ANSWER_ITEM_LENGTH,
  MAX_ANSWER_TEXT_LENGTH,
  VISIBILITIES,
} from "./contract"

// Repository feeds' records (decision 0126, docs/features/feeds.md): a document as Electric delivers it, the
// collector's write, a person's answer and the collector's read of the answers.

/**
 * One row of Postgres `feed_documents` as Electric delivers it, columns in camelCase: its id (`<repo>:<name>`), its
 * repository (`owner/name`, lowercased), its name, who it syncs to, its JSON body and when it last changed.
 */
export const FeedDocument = Schema.Struct({
  id: Schema.String,
  repo: Schema.String,
  name: Schema.String,
  visibility: Schema.Literals(VISIBILITIES),
  body: Schema.Unknown,
  updatedAt: Schema.String,
})
export type FeedDocument = typeof FeedDocument.Type

/** One document the collector sets: who it syncs to and its body, any JSON value. */
export const FeedSet = Schema.Struct({ visibility: Schema.Literals(VISIBILITIES), body: Schema.Unknown })
export type FeedSet = typeof FeedSet.Type

/** The collector's write: each named document set, or deleted with `null`. */
export const IngestRequest = Schema.Struct({ set: Schema.Record(Schema.String, Schema.NullOr(FeedSet)) })
export type IngestRequest = typeof IngestRequest.Type

/** What the write did: documents written, already holding that body, and deleted. */
export const Ingested = Schema.Struct({ written: Schema.Int, unchanged: Schema.Int, deleted: Schema.Int })
export type Ingested = typeof Ingested.Type

const bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))

/**
 * A person's answer to an item a feed shows: keyed by `id`, which the browser chose, so sending it again changes
 * nothing. A choice, a text, or both.
 */
export const AnswerRequest = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  item: bounded(MAX_ANSWER_ITEM_LENGTH),
  choice: Schema.optional(Schema.NullOr(bounded(MAX_ANSWER_CHOICE_LENGTH))),
  text: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(MAX_ANSWER_TEXT_LENGTH)))),
})
export type AnswerRequest = typeof AnswerRequest.Type

/** What ChatApi answers once it recorded an answer: its id and its place in the repository's answers. */
export const Answered = Schema.Struct({ id: Schema.String, seq: Schema.Int })
export type Answered = typeof Answered.Type

/** One answer as the collector reads it, oldest first. */
export const FeedAnswer = Schema.Struct({
  seq: Schema.Int,
  id: Schema.String,
  item: Schema.String,
  choice: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  login: Schema.NullOr(Schema.String),
  at: Schema.String,
})
export type FeedAnswer = typeof FeedAnswer.Type

/** The collector's read: answers after its cursor, and the cursor to ask from next. */
export const FeedAnswers = Schema.Struct({ answers: Schema.Array(FeedAnswer), next: Schema.Int })
export type FeedAnswers = typeof FeedAnswers.Type

/** `feed/answer`'s payload: the repository and the answer. */
export const FeedAnswerPayload = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
  id: AnswerRequest.fields.id,
  item: AnswerRequest.fields.item,
  choice: AnswerRequest.fields.choice,
  text: AnswerRequest.fields.text,
})
export type FeedAnswerPayload = typeof FeedAnswerPayload.Type
