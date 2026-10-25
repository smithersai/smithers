import { useLiveQuery } from "@tanstack/react-db"
import { createContext, useContext } from "react"
import type { RepoAnswer } from "../../auth/viewer"
import { repoId } from "../contract"
import type { RepoView } from "../repo"

// What React components get: the repository layer's live queries to render and plain actions to call
// (features/repo/repo.ts).

const RepoContext = createContext<RepoView | null>(null)

export const RepoProvider = RepoContext.Provider

export const useRepo = (): RepoView => {
  const repo = useContext(RepoContext)
  if (repo === null) throw new Error("useRepo needs a RepoProvider: main.tsx renders one")
  return repo
}

/**
 * Who the person is on `owner/name`, as ChatApi last answered this tab (decision 0079): their role there and whether it
 * is the deployment's own repository; `undefined` until it answers. Every repository route asks (router.tsx `enterRepo`).
 */
export const useRepoAnswer = (owner: string, name: string): RepoAnswer | undefined => {
  const { data } = useLiveQuery(useRepo().queries.roles)
  const id = repoId(owner, name)
  // Nothing before the live query's first read, as on a page rendered before it delivers.
  return (data ?? []).find((row) => row.id === id)
}
