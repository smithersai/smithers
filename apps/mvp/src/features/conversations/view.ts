import type { Listed } from "./schema"

// What the list's rows link to (docs/features/conversations.md#the-list), worked out for the view.

/** The branch route's params for `row`: its repository, and its branch's first segment with the rest as the splat. */
export const paramsOf = (row: Listed) => {
  const [owner = "", repo = ""] = row.repo.split("/")
  const [ref = "", ...rest] = row.branch.split("/")
  return { owner, repo, ref, _splat: rest.join("/") }
}

/** Empty search results distinguish filtering from an empty conversation list. */
export const emptyTitle = (text: string, archived: boolean): string =>
  text.trim() !== "" ? "No matches" : archived ? "No archived conversations" : "No conversations"

/** Branch names repeat across repositories, including for assistive technology. */
export const archiveLabel = (row: Pick<Listed, "branch" | "repo">, archived: boolean): string =>
  `${archived ? "Restore" : "Archive"} ${row.branch} · ${row.repo}`
