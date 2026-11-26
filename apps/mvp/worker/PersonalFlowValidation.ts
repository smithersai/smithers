import { digestSync } from "@smthrs/crypto"
import { Schema } from "effect"
import { MAX_SOURCE_BYTES, RESERVED_NAMES } from "../src/features/flows-ui/contract.ts"
import { type DraftQuestion, FlowName, type SaveRequest, type WriteRequest } from "../src/features/flows-ui/schema.ts"
import { SOURCE_PATH } from "../src/features/flows-ui/source.ts"

export const isName = Schema.is(FlowName)

/** The bytes of `text` as UTF-8. */
export const bytesOf = (text: string) => new TextEncoder().encode(text).length

/** A draft row as the routes read it. */
export interface DraftRow {
  readonly actorId: string
  readonly status: string
  readonly round: number
  readonly request: string
  readonly name: string | null
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>
  readonly checks: ReadonlyArray<{ readonly ok: boolean }>
  readonly questions: ReadonlyArray<DraftQuestion>
  readonly flowId: string | null
  readonly deleted: boolean
  /** The revision this draft's save made: its receipt. `null` until saved, or for a historical save migration 0087 could not identify. */
  readonly savedRevision: number | null
}

/** Whether `name` is one a person's flow may take: the pattern, outside the app's names. */
export const nameAllowed = (name: string): boolean =>
  isName(name) && !(RESERVED_NAMES as ReadonlyArray<string>).includes(name)

/** Why a save can't be admitted, as the code the route answers, or `undefined` when it can. */
export const saveRefusal = (draft: DraftRow, save: SaveRequest): string | undefined => {
  if (!nameAllowed(save.name)) return "name"
  if (bytesOf(save.source) > MAX_SOURCE_BYTES) return "too_large"
  if (digestSync(save.source) !== save.digest) return "digest"
  if (draft.status !== "ready") return "not_ready"
  if (draft.checks.length === 0 || draft.checks.some((check) => !check.ok)) return "checks"
  if (draft.questions.some((question) => question.blocking && question.answer === undefined)) return "needs_you"
  const [file, ...more] = draft.files
  if (file === undefined || more.length > 0 || file.path !== SOURCE_PATH || file.text !== save.source) return "not_draft"
  if (draft.name !== save.name) return "not_draft"
  return undefined
}

/** Why a write can't be admitted before it reaches the database, as the code the route answers, or `undefined`. */
export const writeRefusal = (write: WriteRequest): string | undefined => {
  if (!nameAllowed(write.name)) return "name"
  if (bytesOf(write.source) > MAX_SOURCE_BYTES) return "too_large"
  if (digestSync(write.source) !== write.digest) return "digest"
  return undefined
}
