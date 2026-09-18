import { ViewSkeleton } from "./ViewSkeleton"
import { MarkdownEditorSurface, KnowledgeGraphSurface } from "./ViewModules"
import { flowAction, flowProps } from "./flows/FlowAction"
import { Badge, Button, EmptyState, FileTree } from "@smthrs/ui"
import { BacklinksPanel, OutlineView } from "@smthrs/ui/vault"
import { useLiveQuery } from "@tanstack/react-db"
import { BookOpen, Plus, Trash2, Waypoints } from "lucide-react"
import { Suspense, useMemo } from "react"
import { activeRepositoryId } from "./state/RepoContext"
import { useController } from "./ControllerContext"
import { WIKI_DISPLAY_NAME, WIKI_GRAPH_ALL_SCOPE } from "./state/AppState"
import type { WorldDocument } from "./state/AppState"
import { SurfaceHeader } from "./SurfaceChrome"
import { linkGraphOf, linksOf, neighbourhoodOf } from "./wiki/VaultAdapter"


/* The Wiki pane's graph mode renders over d3-force; it loads on first use like the editor. */


/*
 * The Wiki pane beside the chat: the notes, the open note's editor and link
 * rail, or the graph mode. It reads its own session
 * fields, so selecting a note repaints this pane and not the transcript.
 * `documents` is the shell's path-ordered list, the same array the cards read.
 */
export function WorldSurface({ documents }: { readonly documents: ReadonlyArray<WorldDocument> }) {
  const controller = useController()
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: controller.store.collections.sessions }).select(({ session }) => ({
      id: session.id,
      selectedWorldDocumentId: session.selectedWorldDocumentId,
      wikiPane: session.wikiPane,
      wikiGraphPath: session.wikiGraphPath
    }))
  )
  const session = sessionRows[0] ?? controller.store.session()
  const selected = documents.find((document) => document.id === session.selectedWorldDocumentId) ?? documents[0]
  const selectedPath = selected?.path
  const graphMode = session.wikiPane === "graph"
  const graphPath = session.wikiGraphPath ?? null
  /*
   * Librarian L5: the link rail and the graph are derived from the same
   * notes the sidebar lists (no effect, no second store). The rail shows the
   * open note's backlinks and resolved links out; the graph mode shows every
   * page (the All scope) or one note's neighbourhood. Resolving links parses
   * every note's body, so each is derived once per change of the notes or of
   * what is open, never on a render a streamed token caused.
   */
  const links = useMemo(
    () => graphMode || selectedPath === undefined ? undefined : linksOf(documents, selectedPath),
    [graphMode, documents, selectedPath]
  )
  const graph = useMemo(() => {
    if (!graphMode) return undefined
    const whole = linkGraphOf(documents)
    return graphPath === null ? whole : neighbourhoodOf(whole, graphPath) ?? whole
  }, [graphMode, documents, graphPath])
  const notes = useMemo(() => documents.map((document) => ({ path: document.path, label: document.title })), [documents])

  return (
    <section data-keyboard-pane="Wiki" className="world-surface embedded-pane" aria-label={`Smithers ${WIKI_DISPLAY_NAME} state`}>
      <SurfaceHeader
        icon={<BookOpen size={17} aria-hidden="true" />}
        title={WIKI_DISPLAY_NAME}
        subtitle="What Smithers currently understands"
        closeCommand="chat"
        onClose={() => controller.runCommand("chat")}
      >
        <Button
          variant="ghost"
          size="sm"
          {...flowAction(controller.runCommand, "wiki.new-note")}
        >
          <Plus size={14} aria-hidden="true" />
          New note
        </Button>
        {/* The button door of wiki.graph: the same registry entry the slash and the agent run; it toggles. */}
        <Button
          variant="ghost"
          size="sm"
          {...flowProps("wiki.graph")}
          data-testid="wiki-graph"
          aria-pressed={graphMode}
          onClick={() =>
            // A button always carries its args: a focused graph toggles back from its own focus.
            session.wikiGraphPath ?
              controller.runCommand("wiki.graph", session.wikiGraphPath) :
              controller.runCommand("wiki.graph")}
        >
          <Waypoints size={14} aria-hidden="true" />
          Graph
        </Button>
      </SurfaceHeader>

      <div className="world-workspace" data-pane={graphMode ? "graph" : "document"}>
        <aside
          className="world-sidebar"
          aria-label={`${WIKI_DISPLAY_NAME} notes`}
        >
          <FileTree
            nodeProps={() => flowProps("wiki.select")}
            nodes={notes}
            selected={selectedPath}
            onSelect={(path) => {
              const document = documents.find((candidate) => candidate.path === path)
              if (document) controller.runCommand("wiki.select", document.id)
            }}
          />
        </aside>

        {graph !== undefined ?
          (
            <main
              className="world-graph"
              aria-label={`${WIKI_DISPLAY_NAME} graph`}
              data-testid="wiki-graph-pane"
            >
              <div className="world-document-meta">
                <span data-testid="wiki-pane-graph-scope">
                  {graphPath === null ? WIKI_GRAPH_ALL_SCOPE : `Around ${graphPath}`}
                </span>
              </div>
              <Suspense fallback={<ViewSkeleton />}>
                <KnowledgeGraphSurface
                  notes={graph.notes}
                  links={graph.links}
                  height="100%"
                  onOpenNote={(path) => controller.runCommand("wiki.open", path)}
                />
              </Suspense>
            </main>
          ) :
        <main className="world-document">
          {selected ?
            (
              <>
                <div className="world-document-meta">
                  <span>{selected.path}</span>
                  <div>
                    <Badge variant="outline">
                      {Math.round(selected.confidence * 100)}% confidence
                    </Badge>
                    <Badge variant="muted">
                      {selected.sources.length} source
                      {selected.sources.length === 1 ? "" : "s"}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="world-delete-btn"
                      aria-label={`Delete ${selected.title}`}
                      title="Delete note"
                      {...flowAction(controller.runCommand, "wiki.delete", selected.id)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
                {/* Layout only: the editor releases Tab itself (§21.2, `escapeTabOrder`). */}
                <div className="world-editor-region">
                  <Suspense fallback={<ViewSkeleton />}>
                    <MarkdownEditorSurface
                      value={selected.body}
                      resetKey={selected.id}
                      label={`Edit ${selected.title}`}
                      onChange={(body) => controller.changeWorldDocument(selected.id, body)}
                      /*
                       * Registered twice on purpose: `attachWikiEditor` serves wiki.heading's
                       * scroll; `attachWorldEditor` puts the pane in the map that receives an
                       * accepted remote revision or an agent `remember`, so a keystroke never
                       * writes stale text over a collaborator's.
                       */
                      onEditor={(editor) => {
                        controller.attachWikiEditor(editor)
                        controller.attachWorldEditor(selected.id, "pane", editor)
                      }}
                    />
                  </Suspense>
                </div>
              </>
            ) :
            (
              <EmptyState
                icon={<BookOpen size={20} />}
                title={`No ${WIKI_DISPLAY_NAME} yet`}
                description="Smithers will keep what it learns here."
                action={<Button  {...flowAction(controller.runCommand, "wiki.create", activeRepositoryId(controller.store) ?? undefined)}>Create Wiki</Button>}
              />
            )}
        </main>}
        {graph === undefined && selected !== undefined && links !== undefined ?
          (
            <aside
              className="world-rail"
              aria-label={`${selected.title} links and outline`}
              data-testid="wiki-rail"
            >
              <BacklinksPanel
                backlinks={[...links.backlinks]}
                linksOut={[...links.linksOut]}
                onOpenNote={(path) => controller.runCommand("wiki.open", path)}
                linkProps={(path) => flowProps("wiki.open", path)}
              />
              {/* Each heading is the button door of wiki.heading: the editor scrolls to its source line. */}
              <OutlineView
                markdown={selected.body}
                onHeadingClick={(line) => controller.runCommand("wiki.heading", String(line))}
                headingProps={(heading) => flowProps("wiki.heading", String(heading.line))}
              />
            </aside>
          ) :
          null}
      </div>
    </section>
  )
}
