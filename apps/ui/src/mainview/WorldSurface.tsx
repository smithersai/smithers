import { Badge, Button, EmptyState, FileTree } from "@smthrs/ui"
import { BacklinksPanel, OutlineView } from "@smthrs/ui/vault"
import { useLiveQuery } from "@tanstack/react-db"
import { BookOpen, Factory, Plus, Trash2, Waypoints } from "lucide-react"
import { lazy, Suspense, useMemo } from "react"
import { useController } from "./ControllerContext"
import { stampFlows } from "./FlowStamp"
import { WIKI_DISPLAY_NAME, WIKI_GRAPH_ALL_SCOPE } from "./state/AppState"
import type { WorldDocument } from "./state/AppState"
import { ConfirmDialog, SurfaceHeader } from "./SurfaceChrome"
import { linkGraphOf, linksOf, neighbourhoodOf } from "./wiki/VaultAdapter"

const MarkdownEditorSurface = lazy(() =>
  import("./MarkdownEditorSurface").then((module) => ({ default: module.MarkdownEditorSurface }))
)
/* The Wiki pane's graph mode renders over d3-force; it loads on first use like the editor. */
const KnowledgeGraphSurface = lazy(() =>
  import("./KnowledgeGraphSurface").then((module) => ({ default: module.KnowledgeGraphSurface }))
)

/*
 * The Wiki pane beside the chat: the notes, the open note's editor and link
 * rail, or the graph mode, and the delete confirm. It reads its own session
 * fields, so selecting a note repaints this pane and not the transcript.
 * `documents` is the shell's path-ordered list, the same array the cards read.
 */
export function WorldSurface({ documents }: { readonly documents: ReadonlyArray<WorldDocument> }) {
  const controller = useController()
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: controller.store.collections.sessions }).select(({ session }) => ({
      id: session.id,
      selectedWorldDocumentId: session.selectedWorldDocumentId,
      pendingWorldDeleteId: session.pendingWorldDeleteId,
      wikiPane: session.wikiPane,
      wikiGraphPath: session.wikiGraphPath
    }))
  )
  const session = sessionRows[0] ?? controller.store.session()
  const canShowFactory = controller.commands.find("factory.show") !== undefined
  /*
   * §10.6: the delete question lives in the store, not here — a component is
   * a projection, never an authority, and the local-state version was
   * bypassed entirely by `/wiki.delete <id>` typed into the composer.
   */
  const pendingDelete = documents.find((document) => document.id === (session.pendingWorldDeleteId ?? null))
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
    <section className="world-surface embedded-pane" aria-label={`Smithers ${WIKI_DISPLAY_NAME} state`}>
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
          data-flow="wiki.new-note"
          onClick={() => controller.runCommand("wiki.new-note")}
        >
          <Plus size={14} aria-hidden="true" />
          New note
        </Button>
        {/* The button door of wiki.graph: the same registry entry the slash and the agent run; it toggles. */}
        <Button
          variant="ghost"
          size="sm"
          data-flow="wiki.graph"
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
        {/* The button door of factory.show: the same registry entry the slash and the agent run. */}
        {canShowFactory ?
          (
            <Button
              variant="ghost"
              size="sm"
              data-flow="factory.show"
              data-testid="wiki-factory"
              onClick={() => controller.runCommand("factory.show")}
            >
              <Factory size={14} aria-hidden="true" />
              Factory
            </Button>
          ) :
          null}
      </SurfaceHeader>

      <div className="world-workspace" data-pane={graphMode ? "graph" : "document"}>
        <aside
          className="world-sidebar"
          aria-label={`${WIKI_DISPLAY_NAME} notes`}
        >
          <FileTree
            nodeProps={() => ({ "data-flow": "wiki.select" })}
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
              ref={stampFlows([["button", "wiki.open"]])}
            >
              <div className="world-document-meta">
                <span data-testid="wiki-pane-graph-scope">
                  {graphPath === null ? WIKI_GRAPH_ALL_SCOPE : `Around ${graphPath}`}
                </span>
              </div>
              <Suspense fallback={<p className="smithers-card-note">Loading graph…</p>}>
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
                      data-flow="wiki.delete"
                      aria-label={`Delete ${selected.title}`}
                      title="Delete note"
                      onClick={() => controller.runCommand("wiki.delete", selected.id)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
                {/* Layout only: the editor releases Tab itself (§21.2, `escapeTabOrder`). */}
                <div className="world-editor-region">
                  <Suspense fallback={<p className="smithers-card-note">Loading editor…</p>}>
                    <MarkdownEditorSurface
                      value={selected.body}
                      resetKey={selected.id}
                      label={`Edit ${selected.title}`}
                      onChange={(body) => controller.changeWorldDocument(selected.id, body)}
                      onEditor={controller.attachWikiEditor}
                    />
                  </Suspense>
                </div>
              </>
            ) :
            (
              <EmptyState
                icon={<BookOpen size={20} />}
                title={`No ${WIKI_DISPLAY_NAME} notes yet`}
                description="Smithers will keep what it learns here."
                action={<Button onClick={() => controller.runCommand("wiki.new-note")}>Create a note</Button>}
              />
            )}
        </main>}
        {graph === undefined && selected !== undefined && links !== undefined ?
          (
            <aside
              className="world-rail"
              aria-label={`${selected.title} links and outline`}
              data-testid="wiki-rail"
              ref={stampFlows([['[data-slot="vault-outline"] button', "wiki.heading"], ["button", "wiki.open"]])}
            >
              <BacklinksPanel
                backlinks={[...links.backlinks]}
                linksOut={[...links.linksOut]}
                onOpenNote={(path) => controller.runCommand("wiki.open", path)}
              />
              {/* Each heading is the button door of wiki.heading: the editor scrolls to its source line. */}
              <OutlineView
                markdown={selected.body}
                onHeadingClick={(line) => controller.runCommand("wiki.heading", String(line))}
              />
            </aside>
          ) :
          null}
      </div>
      <ConfirmDialog
        open={pendingDelete !== undefined}
        title={`Delete ${pendingDelete?.title ?? "note"}?`}
        body={`This note leaves the ${WIKI_DISPLAY_NAME}. You can write it again, but Smithers will treat it as new.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => controller.runCommand("wiki.delete.confirm")}
        onCancel={() => controller.runCommand("wiki.delete.cancel")}
      />
    </section>
  )
}
