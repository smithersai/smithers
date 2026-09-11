import { KnowledgeGraph } from "@smthrs/ui/adapters/knowledge-graph"
import type { VaultLink, VaultNoteMeta } from "@smthrs/ui/vault"

/**
 * Heavy graph adapter boundary: `@smthrs/ui/adapters/knowledge-graph` renders
 * over d3-force, so the Wiki pane's graph mode and the wiki-graph card load
 * this module lazily, the way MarkdownEditorSurface loads the editor. A row
 * click is the button door of `wiki.open`; the caller binds it.
 */
export function KnowledgeGraphSurface({
  notes,
  links,
  height,
  onOpenNote
}: {
  readonly notes: ReadonlyArray<VaultNoteMeta>
  readonly links: ReadonlyArray<VaultLink>
  readonly height?: number | string
  readonly onOpenNote: (path: string) => void
}) {
  return <KnowledgeGraph notes={[...notes]} links={[...links]} height={height} onOpenNote={onOpenNote} />
}
