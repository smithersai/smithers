/** Repository-scoped agent configuration shared by the editor, roles and run launch. */
import { useSyncExternalStore } from "react"
import { agents, repo } from "../../fixtures"

const edits = new Map<string, Record<string, string>>()
const listeners = new Set<() => void>()
let revision = 0
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const snapshot = () => revision
const key = () => `repo-agent-models:${repo.slug}`
const local = () => {
  let models = edits.get(repo.slug)
  if (!models) {
    try { models = JSON.parse(sessionStorage.getItem(key()) ?? "{}") } catch { /* Storage is optional. */ }
    if (!models || typeof models !== "object" || Array.isArray(models)) models = {}
    edits.set(repo.slug, models)
  }
  return models
}
export const allAgents = () => {
  const models = local()
  return agents.map(agent => ({ ...agent, model: typeof models[agent.id] === "string" ? models[agent.id] : agent.model }))
}
export const useAgents = () => {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return allAgents()
}
export const saveAgentModel = (id: string, model: string) => {
  const models = local()
  models[id] = model
  try { sessionStorage.setItem(key(), JSON.stringify(models)) } catch { /* Keep the in-memory edit. */ }
  revision += 1
  listeners.forEach(listener => listener())
}
