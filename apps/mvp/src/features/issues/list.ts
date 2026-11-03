import type { ListedIssue } from "./schema"

/** Shared URL state and client-side ordering over synced issue and pull request rows. */
export const LIST_SORTS = ["newest", "oldest", "updated"] as const
export type ListSort = (typeof LIST_SORTS)[number]
export const listSearch = (search: Record<string, unknown>): { readonly q?: string; readonly sort?: ListSort } => ({
  ...(typeof search.q === "string" && search.q.trim() !== "" ? { q: search.q } : {}),
  ...(LIST_SORTS.includes(search.sort as ListSort) ? { sort: search.sort as ListSort } : {}),
})

/** The date displayed is the date used for ordering. Pending writes stay before synced rows. */
export const visibleRows = <A extends { readonly title: string; readonly number: number; readonly updatedAt: string; readonly createdAt?: string; readonly local?: number }>(
  rows: ReadonlyArray<A>, search: { readonly q?: string; readonly sort?: ListSort },
): ReadonlyArray<A> => {
  const query = (search.q ?? "").trim().toLocaleLowerCase()
  const sort = search.sort ?? "updated"
  return rows.filter((row) => `${row.title} #${row.number}`.toLocaleLowerCase().includes(query))
    .map((row) => ({ ...row, updatedAt: sort === "updated" ? row.updatedAt : row.createdAt ?? row.updatedAt }))
    .sort((a, b) => (b.local ?? 0) - (a.local ?? 0) ||
      (sort === "oldest" ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt)) || b.number - a.number)
}

/** A row of the list, as `visibleRows` and the page read it. */
type SearchableRow = {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly state: string
  readonly author: string | null
  readonly comments: number
  readonly updatedAt: string
  readonly createdAt?: string
  readonly triage: string
  readonly commitment?: string | null
  readonly pending: string
  readonly reason: unknown
  readonly local: number
}

/**
 * `rows`, with what the issues route answered this very search on this repository (schema.ts `Searched`), for a list
 * that hasn't synced: a row the device already has stays as it is. Any other search's answer adds nothing.
 */
export const withSearched = <A extends SearchableRow>(
  rows: ReadonlyArray<A>,
  searched: { readonly repoId: string; readonly q: string; readonly issues: ReadonlyArray<ListedIssue> } | undefined,
  repoId: string,
  q: string | undefined,
): ReadonlyArray<A | SearchableRow> => {
  if (searched === undefined || searched.repoId !== repoId || searched.q !== (q ?? "").trim()) return rows
  const held = new Set(rows.map((row) => row.number))
  return [
    ...rows,
    ...searched.issues.filter((issue) => !held.has(issue.number)).map((issue): SearchableRow => ({
      id: `${repoId}#${issue.number}`,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      author: issue.author.login ?? "",
      comments: issue.comments,
      updatedAt: issue.updated_at,
      createdAt: issue.created_at,
      triage: issue.triage,
      commitment: issue.commitment ?? "",
      pending: "",
      reason: "",
      local: 0,
    })),
  ]
}
