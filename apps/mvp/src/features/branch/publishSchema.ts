import { Schema } from "effect"
import { SYNC_STATES, UPDATE_STATES } from "./contract"

// Publish's, Update branch's and Resync's rows on the branch page (docs/features/branch-publish.md#the-branch-page): a
// branch's publication as Electric delivers it, and this tab's own presses of Publish, Update branch and Resync.

/** One row of Postgres `branch_publications` (`PUBLICATION_COLUMNS`), columns in camelCase. */
export const PublicationRow = Schema.Struct({
  branchId: Schema.String,
  repoId: Schema.String,
  githubRef: Schema.String,
  baseRef: Schema.String,
  baseSha: Schema.String,
  headSha: Schema.String,
  prNumber: Schema.Number,
  updateState: Schema.NullOr(Schema.Literals(UPDATE_STATES)),
  syncedSha: Schema.NullOr(Schema.String),
  syncState: Schema.NullOr(Schema.Literals(SYNC_STATES)),
  syncConflicts: Schema.NullOr(Schema.Array(Schema.String)),
  updatedAt: Schema.String,
})
export type PublicationRow = typeof PublicationRow.Type

/** The title of a published branch's pull request, from its repository's issues once the device has its row. */
export const PullTitle = Schema.Struct({
  branchId: Schema.String,
  title: Schema.String,
})
export type PullTitle = typeof PullTitle.Type

/**
 * Why this tab's press of Publish or Update branch didn't start a write: `branch/publish`'s or `branch/update`'s
 * refusal (`exists`: a Publish is on its way or the branch is published), or `unavailable` when the flow couldn't run
 * to an answer.
 */
export const PRESS_REFUSALS = ["exists", "sign_in", "forbidden", "not_found", "invalid", "not_configured", "unavailable"] as const
export type PressRefusal = (typeof PRESS_REFUSALS)[number]

/**
 * This tab's presses on one branch, by its id: whether Publish's form shows, and for each of Publish, Update branch and
 * Resync whether its flow runs now (`publishing`, `updating`, `resyncing`), the write it answered, or why it refused.
 */
export const PublishPress = Schema.Struct({
  branchId: Schema.String,
  form: Schema.Boolean,
  publishing: Schema.Boolean,
  publishWriteId: Schema.NullOr(Schema.String),
  publishRefused: Schema.NullOr(Schema.Literals(PRESS_REFUSALS)),
  updating: Schema.Boolean,
  updateWriteId: Schema.NullOr(Schema.String),
  updateRefused: Schema.NullOr(Schema.Literals(PRESS_REFUSALS)),
  resyncing: Schema.Boolean,
  resyncWriteId: Schema.NullOr(Schema.String),
  resyncRefused: Schema.NullOr(Schema.Literals(PRESS_REFUSALS)),
})
export type PublishPress = typeof PublishPress.Type
