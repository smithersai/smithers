/** The Wiki is an opt-in release capability. The mythical history is core
 * (D-09 superseded, Will 2026-09-25) and always available, like native source,
 * commit history, files and user-authored flows. */
export interface KnowledgeFeatures {
  readonly wiki?: boolean
  readonly pluginLibrary?: boolean
}

/** The build-time Wiki door AppController reads, for boot code that runs before a controller exists. */
export const wikiFlagEnabled = (): boolean => import.meta.env?.VITE_SMITHERS_WIKI === "true"

/** Applies to the command registry and the built-in repository-flow catalog. */
export const knowledgeFlowAvailable = (name: string, features: KnowledgeFeatures = {}): boolean => {
  if (/^(?:wiki|world)(?:[./]|$)/.test(name) || name === "search.wiki" || name === "librarian/wiki" || name === "checks/wiki") {
    return features.wiki === true
  }
  return true
}

/** A runtime-listed Flow can run even when its older built-in UI door is off. */
export const runtimeFlowAvailable = (name: string, features: KnowledgeFeatures = {}): boolean =>
  name.startsWith("librarian/") || knowledgeFlowAvailable(name, features)

/** Restored cards must obey the same release flags as new command dispatch. */
export const knowledgeCardAvailable = (kind: string, features: KnowledgeFeatures = {}): boolean => {
  if (["world", "wiki", "wiki-list", "wiki-links", "wiki-graph"].includes(kind)) return features.wiki === true
  if (kind === "plugin-library") return features.pluginLibrary === true
  return true
}
