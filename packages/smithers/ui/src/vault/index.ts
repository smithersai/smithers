export {
  NOTE_HREF,
  joinFrontmatter,
  noteHref,
  noteLabel,
  parseWikilinks,
  pathFromHref,
  restoreWikilinks,
  splitFrontmatter,
  wikilinksToMarkdown,
  type Wikilink,
} from "./wikilinks";
export type { VaultAdapter, VaultDataAttributes, VaultLink, VaultNoteMeta, VaultRowProps } from "./types";
export { vaultDataAttributes } from "./types";
export {
  GRAPH_FOLDER_TINTS,
  HUB_LABEL_MIN_DEGREE,
  computeGraphModel,
  folderHue,
  folderTint,
  folderTintIndex,
  neighbourSet,
  nodeRadius,
  noteFolder,
  shouldShowLabel,
  type GraphFolderTint,
  type VaultGraphEdge,
  type VaultGraphNode,
} from "./graphModel";
export { VAULT_CSS_ID, vaultCss } from "./vaultCss";
export { useVaultCss } from "./useVaultCss";
// `KnowledgeGraph` is deliberately absent: it renders over `d3-force` and so
// ships from `@smthrs/ui/adapters/knowledge-graph`, like every other heavy
// renderer in this package. Re-exporting it here pulled d3-force into the base
// barrel for every consumer (`tests/barrel-weight.test.ts`).
export { BacklinksPanel, type BacklinksPanelProps } from "./BacklinksPanel";
export { OutlineView, parseOutline, type OutlineHeading, type OutlineViewProps } from "./OutlineView";
export {
  AUTOSAVE_STATUS_TEXT,
  autosaveStatusText,
  createAutosaveDoc,
  type AutosaveDoc,
  type AutosaveDocOptions,
  type AutosaveFailure,
  type AutosaveFailureCode,
  type AutosaveRevision,
  type AutosaveSaveResult,
  type AutosaveSnapshot,
  type AutosaveState,
} from "./autosaveMachine";
export { useAutosaveDoc, type UseAutosaveDocOptions, type UseAutosaveDocResult } from "./useAutosaveDoc";
