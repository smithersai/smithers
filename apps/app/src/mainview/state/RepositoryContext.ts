import { GUIDE_BRIDGE } from "../onboarding/lessons"
import { z } from "zod"
import { AgentRepositoryUpdateSchema, type AgentRepositoryUpdate } from "@smthrs/rpc/AgentContext"
import type { AppStore } from "./AppStore"
import { conversationTabIdOf } from "./AppState"
import { resolveTargetRepo } from "./RepoContext"
import { isPracticeRepo, PRACTICE_REPO } from "./practice/PracticeRepository"

/** Durable background observations are separate from presentation and human read receipts. */
export const RepositoryContextSchema = z.object({
  id: z.string(), scope: z.string(), conversation: z.string().optional(), data: AgentRepositoryUpdateSchema
})
export type RepositoryContext = z.infer<typeof RepositoryContextSchema>

export function repositoryScope(store: AppStore, repo: string): string {
  if (isPracticeRepo(repo)) return `practice:${store.session().guide?.playthrough ?? 0}`
  const identity = store.collections.identitySessions.get("identity")
  return identity?.state === "signed-in" ? `github:${identity.login}` : "anonymous"
}

/** Never carry observations from another account, conversation, or tutorial playthrough. */
export function currentRepositoryUpdate(store: AppStore): AgentRepositoryUpdate | undefined {
  const guide = store.session().guide
  const target = guide && guide.step > 0 && guide.step < GUIDE_BRIDGE
    ? { repo: PRACTICE_REPO } : resolveTargetRepo(store, undefined)
  if ("error" in target) return undefined
  const repo = target.repo
  const conversation = conversationTabIdOf(store.session())
  const scope = repositoryScope(store, repo)
  return store.collections.repositoryContexts.get(JSON.stringify([scope, repo, conversation]))?.data
}
