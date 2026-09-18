import { KnowledgeGraph } from "@smthrs/ui/adapters/knowledge-graph"
import type { VaultLink, VaultNoteMeta } from "@smthrs/ui/vault"
import { flowProps } from "./flows/FlowAction"

/**
 * Heavy graph adapter boundary: `@smthrs/ui/adapters/knowledge-graph` renders
 * over d3-force, so the Wiki pane's graph mode and the wiki-graph card load
 * this module lazily, the way MarkdownEditorSurface loads the editor.
 *
 * A node is the button door of `wiki.open`, and it says so: the adapter's
 * `nodeProps` hook puts the binding on the hub rows and the rendered SVG
 * nodes. Both callers open a note, so the binding lives here once rather
 * than at each of them.
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
  return (
    <KnowledgeGraph
      notes={[...notes]}
      links={[...links]}
      height={height}
      onOpenNote={onOpenNote}
      nodeProps={(node) => flowProps("wiki.open", node.id)}
    />
  )
}
