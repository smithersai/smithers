import { AgentRepositoryUpdateSchema,type AgentRepositoryUpdate } from "@smthrs/rpc/AgentContext"
import { z } from "zod"
import { conversationTabIdOf } from "./AppState"
import type { AppStore } from "./AppStore"
import { resolveTargetRepo } from "./RepoContext"

/** Durable background observations are separate from presentation and human read receipts. */
export const RepositoryContextSchema = z.object({
  id: z.string(), scope: z.string(), conversation: z.string().optional(), data: AgentRepositoryUpdateSchema
})
export type RepositoryContext = z.infer<typeof RepositoryContextSchema>

export function repositoryScope(store: AppStore, _repo: string): string {
  const identity = store.collections.identitySessions.get("identity")
  return identity?.state === "signed-in" ? `github:${identity.login}` : "anonymous"
}

/** Never carry observations from another account or conversation. */
export function currentRepositoryUpdate(store: AppStore): AgentRepositoryUpdate | undefined {
  const target = resolveTargetRepo(store, undefined)
  if ("error" in target) return undefined
  const repo = target.repo
  const conversation = conversationTabIdOf(store.session())
  const scope = repositoryScope(store, repo)
  return store.collections.repositoryContexts.get(JSON.stringify([scope, repo, conversation]))?.data
}
