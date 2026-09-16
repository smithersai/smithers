import { AGENT_ROLES } from "@smthrs/rpc/AgentRoles"
import type { AgentRole } from "@smthrs/rpc/AgentRoles"
import { json, Router } from "../routes"
import type { HarnessDetector } from "./harnesses"

export const AGENTS_PATH = "/api/agents"

export interface AgentStore {
  readonly list: () => Promise<ReadonlyArray<AgentRole>>
  readonly get: (id: string) => Promise<AgentRole | undefined>
}

export const createAgentStore = (): AgentStore => ({
  list: async () => AGENT_ROLES,
  get: async (id) => AGENT_ROLES.find(role => role.id === id)
})

export interface AgentRoutesOptions {
  readonly stateDir?: string
  readonly harnesses: HarnessDetector
  readonly log?: (line: string) => void
}

export const registerAgentRoutes = (router: Router, _options: AgentRoutesOptions): { readonly store: AgentStore } => {
  const store = createAgentStore()
  router.add("GET", AGENTS_PATH, async () => json({ agents: await store.list() }))
  return { store }
}
