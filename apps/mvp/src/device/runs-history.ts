import { Schema } from "effect"
import { MAX_ANSWER_LENGTH } from "../features/status/contract"
import { Run } from "../features/status/schema"

const { repoId: _repoId, ...v3Fields } = Run.fields
const { conversationId: _conversationId, ...v2Fields } = v3Fields

/**
 * Deployed runs v3, before a run's row named its repository (an agent's question to the person, `queue/ask`, names
 * one). A v4 device syncs its runs again from the start.
 */
export const RunV3 = Schema.Struct(v3Fields)

/**
 * Deployed runs v2, before a run's row named its conversation (decision 0110, the data gate): its waits couldn't be
 * attributed to a repository. A v3 device syncs its runs again from the start.
 */
export const RunV2 = Schema.Struct(v2Fields)

/**
 * Deployed runs v1, before an approval's answer could carry a note (decision 0021): an answer was words, an option, or
 * Approve or Deny. Kept so the migrations fixture still checks a v1 device's rows against the schema they were written in.
 */
export const RunV1 = Schema.Struct({
  ...v2Fields,
  answer: Schema.NullOr(
    Schema.Struct({ value: Schema.Union([Schema.String.check(Schema.isMaxLength(MAX_ANSWER_LENGTH)), Schema.Boolean]) }),
  ),
})
