import { COMMENTS_SHAPE_ROUTE, ITEMS_SHAPE_ROUTE, issueNumberOf, itemId } from "../../src/features/issues/contract.ts"

/** Server-owned filters: a route may narrow an authorized repository, never supply SQL or widen its scope. */
export const itemShape = (path: string, where: string, repoId: string, selected: string | null) => {
  const params: Record<string, string> = { "1": repoId }
  if (selected === null || (path !== ITEMS_SHAPE_ROUTE && path !== COMMENTS_SHAPE_ROUTE)) return { where, params }
  const number = issueNumberOf(selected)
  if (number === undefined) return undefined
  params["2"] = path === ITEMS_SHAPE_ROUTE ? String(number) : itemId(repoId, number)
  return { where: `${where} AND ${path === ITEMS_SHAPE_ROUTE ? "number" : "item_id"} = $2`, params }
}
