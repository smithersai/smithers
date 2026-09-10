import { Badge, Button, FileTree } from "@smthrs/ui"
import { ExternalLink, GitPullRequest, HardDrive, Server } from "lucide-react"
import { lazy, Suspense, useId } from "react"
import { parseOutline } from "@smthrs/ui/vault"
import type { MarkdownEditorHandle } from "@smthrs/ui/adapters/markdown-editor"
import type { Card, WorldDocument } from "../state/AppState"
import { WIKI_DISPLAY_NAME } from "../state/AppState"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

const MarkdownEditorSurface = lazy(() =>
  import("../MarkdownEditorSurface").then((module) => ({ default: module.MarkdownEditorSurface }))
)

/*
 * The connect surface as an embedded card (§2c″ — the agent's connect form):
 * the same extension-store grammar as the pane, derived from the session the
 * card was rendered with. Sign-in and the GitHub connector are one act
 * (§2a′): a signed-in session reads Connected, never "connect again".
 */
export const ConnectCardBody = ({
  card,
  onConnectGitHub,
  onConnectLocal,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "connect" }>
  readonly onConnectGitHub: () => void
  readonly onConnectLocal: () => void
  readonly onRunCommand: RunCommand
}) => (
  <ul className="connect-store-list">
    <li className="connect-store-row">
      <span className="connect-store-icon">
        <GitPullRequest size={16} aria-hidden="true" />
      </span>
      <span className="connect-store-text">
        <strong>GitHub</strong>
        <span>Issues, pull requests, and reviews from the repositories you choose.</span>
      </span>
      {card.payload.github.connected ?
        <Badge variant="success">Connected ✓ as {card.payload.github.login ?? "you"}</Badge> :
        (
          <Button size="sm" data-flow="auth.sign-in" onClick={() => onConnectGitHub()}>
            Connect
          </Button>
        )}
    </li>
    {card.payload.nativeAvailable ?
      (
        <li className="connect-store-row">
          <span className="connect-store-icon">
            <HardDrive size={16} aria-hidden="true" />
          </span>
          <span className="connect-store-text">
            <strong>Local repository</strong>
            <span>A repository on this machine, read directly.</span>
          </span>
          <Button size="sm" variant="outline" data-flow="connector.add" onClick={() => onConnectLocal()}>
            Connect
          </Button>
        </li>
      ) :
      null}
    <li className="connect-store-row">
      <span className="connect-store-icon">
        <Server size={16} aria-hidden="true" />
      </span>
      <span className="connect-store-text">
        <strong>Smithers Cloud repository</strong>
        <span>Import a GitHub repository into hosted workspace storage.</span>
      </span>
      <Button size="sm" variant="outline" data-flow="repos.import" onClick={() => onRunCommand("repos.import")}>
        Import
      </Button>
    </li>
  </ul>
)

/*
 * The world query's embedded answer card (§2c″) — the answer rides in the chat
 * text beside it. The card is a browsable slice of the world: the surfaced
 * documents as a file tree, the selected one open in the markdown editor.
 * Bodies come from the LIVE worldDocuments collection (the payload is a
 * path/title/confidence snapshot), so a note deleted since the query gets an
 * honest note instead of stale text.
 */
export const WorldCardBody = ({
  card,
  worldDocuments,
  onChangeWorldDocument,
  onAttachWorldEditor,
  onRunCommand
}: {
  readonly card: Extract<Card, { kind: "world" }>
  readonly worldDocuments: ReadonlyArray<WorldDocument>
  readonly onChangeWorldDocument: (id: string, body: string) => void
  readonly onAttachWorldEditor?: (id: string, slot: string, editor: MarkdownEditorHandle | null) => void
  readonly onRunCommand: RunCommand
}) => {
  const editorSlot = useId()
  if (card.payload.documents.length === 0) {
    return <div className="world-card-empty"><p>No Wiki pages in this view.</p>{card.payload.index !== undefined && card.payload.index.page > 1 ?
      <Button size="sm" data-flow="wiki.cloud" onClick={() => onRunCommand("wiki.cloud", `${card.payload.index!.repo} ${card.payload.index!.page - 1}`)}>Previous page</Button> : null}</div>
  }
  const documents = card.payload.documents.map((entry) => ({ entry, document: worldDocuments.find((document) =>
    entry.id === undefined ? document.path === entry.path : document.id === entry.id) }))
  const selected = documents.find(({ entry, document }) => (document?.id ?? entry.id) === card.payload.selectedDocumentId) ?? documents[0]!
  const { entry, document } = selected
  const treePath = ({ entry, document }: typeof selected) => document?.cloud?.slug ?? entry.cloud?.slug ?? document?.path ?? entry.path
  const view = card.payload.view ?? "outline"
  const cloud = document?.cloud
  const readOnly = cloud !== undefined && (cloud.phase === "cached" || cloud.phase === "deleted")
  return (
    <div className="world-card-workspace">
      <aside className="world-card-sidebar" aria-label={`${WIKI_DISPLAY_NAME} documents`}>
        <FileTree
          nodes={documents.map((row) => ({ path: treePath(row), label: row.document?.title ?? row.entry.title }))}
          selected={treePath(selected)}
          onSelect={(path) => {
            const row = documents.find((candidate) => treePath(candidate) === path)
            if (row !== undefined) onRunCommand("wiki.card.select", `${card.id} ${row.document?.id ?? row.entry.id ?? row.entry.path}`)
          }}
        />
        {card.payload.index === undefined ? null : <div className="wiki-card-pages">
          {card.payload.index.page <= 1 ? null : <Button size="sm" variant="ghost" data-flow="wiki.cloud" onClick={() =>
            onRunCommand("wiki.cloud", `${card.payload.index!.repo} ${card.payload.index!.page - 1}`)}>Previous page</Button>}
          {card.payload.index.hasNext ? <Button size="sm" variant="ghost" data-flow="wiki.cloud" onClick={() =>
            onRunCommand("wiki.cloud", `${card.payload.index!.repo} ${card.payload.index!.page + 1}`)}>Next page</Button> : null}
        </div>}
      </aside>
      <div className="world-card-doc">
        <div className="world-card-meta">
          <span className="world-card-path">{document?.path ?? entry.path}</span>
          <div className="wiki-card-views" aria-label="Wiki view">
            {(["outline", "document"] as const).map((mode) => <Button key={mode} size="sm" variant="ghost"
              aria-pressed={view === mode} data-flow="wiki.card.view"
              onClick={() => onRunCommand("wiki.card.view", `${card.id} ${mode}`)}>
              {mode === "outline" ? "Outline" : "Document"}
            </Button>)}
          </div>
        </div>
        {document === undefined ? entry.cloud === undefined ? <p className="world-card-empty">This note is no longer available in {WIKI_DISPLAY_NAME}.</p> :
          <div className="wiki-card-outline"><h3>{entry.title}</h3><p>Page revision {entry.cloud.revision}</p>
            <Button size="sm" data-flow="wiki.cloud.open" onClick={() => onRunCommand("wiki.cloud.open", `${entry.cloud!.slug} ${entry.cloud!.repo}`)}>Open page</Button>
          </div> : <>
          {cloud === undefined ? null : <div className="wiki-card-source">
            <span>Page revision {cloud.remoteRevision} · {cloud.remoteAuthor}</span>
            <span>{cloud.pending.length === 0 ? "No pending edits" : `${cloud.pending.length} pending edit${cloud.pending.length === 1 ? "" : "s"}`}</span>
            {cloud.phase === "deleted" ? null : <Button size="sm" variant="ghost" data-flow="wiki.sync"
              onClick={() => onRunCommand("wiki.sync", document.id)}>Refresh</Button>}
            {cloud.phase === "cached" ? <p>This is a saved copy. Refresh to resume collaboration.</p> : null}
            {cloud.error === null ? null : <p role="status">{cloud.error}</p>}
          </div>}
          {view === "outline" ? <div className="wiki-card-outline">
            <h3>{document.title}</h3>
            <ol aria-label="Page outline">{parseOutline(document.body).map((heading) =>
              <li key={heading.line} data-depth={heading.depth}>{heading.text}</li>)}</ol>
            <details><summary>Sources</summary><ul>{document.sources.map((source) => <li key={source}>{source}</li>)}</ul>
              {cloud === undefined ? <p>Saved by {document.updatedBy} at app revision {document.revision}.</p> :
                <p>Page {cloud.pageId} in {cloud.repo}. Recorded at {cloud.remoteUpdatedAt}.</p>}
            </details>
          </div> : <Suspense fallback={<p className="smithers-card-note">Loading editor…</p>}>
            <MarkdownEditorSurface
              value={document.body}
              resetKey={document.id}
              label={`${readOnly ? "Read" : "Edit"} ${document.title}`}
              readOnly={readOnly}
              onChange={(body) => onChangeWorldDocument(document.id, body)}
              onEditor={(editor) => onAttachWorldEditor?.(document.id, `${card.id}:${editorSlot}`, editor)}
            />
          </Suspense>}
        </>}
      </div>
    </div>
  )
}

/*
 * The browser surface (§2d′): the page embedded in an iframe with its URL
 * visible; a site that refuses framing gets the honest state + the one next
 * step, never a silent blank.
 */
export const BrowserCardBody = ({ card }: { readonly card: Extract<Card, { kind: "browser" }> }) => {
  const { url, finalUrl, frameable, blockReason, error } = card.payload
  const shownUrl = finalUrl ?? url
  if (error !== undefined) {
    return (
      <p className="sui-approval-error" role="alert">
        {error}
      </p>
    )
  }
  return (
    <div className="browser-card">
      {/* NO INVENTION: §2d′ asks for the frame with the URL visible — nothing else. */}
      <p className="browser-card-url">
        <ExternalLink size={12} aria-hidden="true" /> {shownUrl}
      </p>
      {frameable ?
        (
          /*
           * §8.13: the app document is cross-origin isolated (COEP
           * require-corp) because OPFS needs it, and under that policy Chrome
           * blocks every cross-origin frame whose response carries no CORP
           * header — which is practically every site on the public web. The
           * frame went to chrome-error:// and the card rendered an empty white
           * box while its pill still read DONE. A credentialless frame is the
           * escape hatch the policy ships with: it loads third-party documents
           * without credentials and without demanding CORP of them, and the
           * document stays isolated.
           */
          <iframe
            className="browser-card-frame"
            src={shownUrl}
            title={shownUrl}
            // @ts-expect-error React has no typing for the credentialless attribute yet.
            credentialless=""
            sandbox="allow-scripts allow-same-origin"
          />
        ) :
        (
          <div className="browser-card-blocked">
            <p>{blockReason ?? "This site can't be embedded here."}</p>
            <a className="browser-card-open" href={shownUrl} target="_blank" rel="noreferrer">
              Open in a new tab
            </a>
          </div>
        )}
    </div>
  )
}


/* These cards exist once their read has settled, so they wear "done" (§28.3). */
export const conversationCardFamily: CardFamily<"connect" | "world" | "browser"> = {
  connect: {
    render: (card, actions) => (
      <ConnectCardBody
        card={card}
        onConnectGitHub={actions.onConnectGitHub}
        onConnectLocal={actions.onConnectLocal}
        onRunCommand={actions.onRunCommand}
      />
    ),
    pill: settledPill
  },
  world: {
    render: (card, actions) => (
      <WorldCardBody
        card={card}
        worldDocuments={actions.worldDocuments}
        onChangeWorldDocument={actions.onChangeWorldDocument}
        onAttachWorldEditor={actions.onAttachWorldEditor}
        onRunCommand={actions.onRunCommand}
      />
    ),
    pill: settledPill
  },
  browser: { render: (card) => <BrowserCardBody card={card} />, pill: settledPill }
}
