/** Generated repository knowledge is an opt-in release capability. Native
 * source, commit history, files and user-authored flows remain available. */
export interface KnowledgeFeatures {
  readonly wiki?: boolean
  readonly mythicalHistory?: boolean
  readonly pluginLibrary?: boolean
}

/** The build-time Wiki door AppController reads, for boot code that runs before a controller exists. */
export const wikiFlagEnabled = (): boolean => import.meta.env?.VITE_SMITHERS_WIKI === "true"

/** Applies to the command registry and the built-in repository-flow catalog. */
export const knowledgeFlowAvailable = (name: string, features: KnowledgeFeatures = {}): boolean => {
  if (/^(?:wiki|world)(?:[./]|$)/.test(name) || name === "search.wiki" || name === "librarian/wiki" || name === "checks/wiki") {
    return features.wiki === true
  }
  if (/^history(?:[./]|$)/.test(name) || name === "search.history" || name === "librarian/history") {
    return features.mythicalHistory === true
  }
  return true
}

/** Restored cards must obey the same release flags as new command dispatch. */
export const knowledgeCardAvailable = (kind: string, features: KnowledgeFeatures = {}): boolean => {
  if (["world", "wiki", "wiki-list", "wiki-links", "wiki-graph"].includes(kind)) return features.wiki === true
  if (kind === "history") return features.mythicalHistory === true
  if (kind === "plugin-library") return features.pluginLibrary === true
  return true
}
