/** The plugin library is an opt-in release capability. The Wiki (D-09b) and
 * the mythical history are core and always available, like native source,
 * commit history, files and user-authored flows. */
export interface KnowledgeFeatures {
  readonly pluginLibrary?: boolean
}

/** Restored cards must obey the same release flag as new command dispatch. */
export const knowledgeCardAvailable = (kind: string, features: KnowledgeFeatures = {}): boolean =>
  kind !== "plugin-library" || features.pluginLibrary === true
