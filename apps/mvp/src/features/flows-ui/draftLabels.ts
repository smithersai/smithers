import type { Draft } from "./schema"

type Row = Pick<Draft, "id" | "name" | "request" | "createdAt">
const baseOf = (draft: Row) => draft.name ?? draft.request
const contextOf = (draft: Row) => draft.name === null ? draft.request : `${draft.name} · ${draft.request.slice(0, 80)}`

/** Repeated names show their request; repeated requests also have a stable ordinal. */
export const draftLabel = (draft: Row, drafts: ReadonlyArray<Row>): string => {
  const same = drafts.filter(row => baseOf(row) === baseOf(draft))
  if (same.length < 2) return baseOf(draft)
  const context = contextOf(draft)
  const repeated = same.filter(row => contextOf(row) === context)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  return repeated.length < 2 ? context : `${context} · ${repeated.findIndex(row => row.id === draft.id) + 1}`
}
