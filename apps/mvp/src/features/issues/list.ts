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
