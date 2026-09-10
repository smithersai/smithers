import { fileArgs } from "../flows/FileArgs"
/*
 * The repo file cards: a directory listing ("file-list") whose rows open
 * /files.list or /files.read, and a file view ("file") rendered as a fenced
 * code block, honest about truncation. Every row is a command binding through
 * onRunCommand — the one delegated dispatch CardView threads from App.tsx —
 * and carries data-flow with its registered command name.
 */
import { lspLanguageFor } from "@smthrs/rpc/LocalApp"
import { Button } from "@smthrs/ui"
import { FileText, Folder } from "lucide-react"
import { lazy, Suspense, useContext } from "react"
import type { ReactNode } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import type { Card } from "../state/AppState"
import { shortId } from "../state/ids"
import type { AppController } from "../state/AppController"
import { ControllerContext } from "../ControllerContext"
import type { CardFamily, RunCommand } from "./CardFamily"
import { settledPill } from "./CardFamily"

/*
 * A markdown file renders through the shared WYSIWYG editor the World notes
 * use (will, 2026-09-01), read only: nothing writes a repository file back.
 * The adapter is heavy, so it loads only when a markdown card is on screen.
 */
const MarkdownEditorSurface = lazy(() =>
  import("../MarkdownEditorSurface").then((module) => ({ default: module.MarkdownEditorSurface }))
)

/*
 * Code intelligence L1 (docs/code-intel/PLAN.md §1): a code file renders
 * through `@pierre/diffs` `File` (Shiki underneath) behind this boundary, so
 * pierre and the grammars land in an async chunk that never imports the
 * entry. The plain block is the complete first state while the chunk loads.
 */
const CodeSurface = lazy(() => import("./CodeSurface").then((module) => ({ default: module.CodeSurface })))

/** Markdown by extension: the editor renders these; code goes through the code view; the rest is a plain block. */
export const isMarkdownPath = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path)

/*
 * The language word the header shows (docs/code-intel/PLAN.md §5), by
 * extension, in the grammar's own name. Only the languages the app meets
 * are named; a file outside the table shows no word, which is a complete
 * state. The header renders without the lazy surface, so the table lives
 * here rather than behind the adapter's grammar registry.
 */
const LANGUAGE_WORDS: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  md: "Markdown",
  mdx: "Markdown",
  markdown: "Markdown",
  rs: "Rust",
  go: "Go",
  py: "Python",
  css: "CSS",
  html: "HTML",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell"
}
export const languageWord = (path: string): string | null => {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension === undefined ? null : LANGUAGE_WORDS[extension] ?? null
}

/**
 * The count line under the header, present only once the server answered:
 * errors and warnings, as the mockup counts them — of the rows the card
 * holds, so when the host's cap cut the publication the line says how many
 * of the total it counted rather than passing the cap off as the total.
 */
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`
export const diagnosticsCount = (items: ReadonlyArray<{ readonly severity: string }>, total?: number): string =>
  `${plural(items.filter((item) => item.severity === "error").length, "error")} · ${
    plural(items.filter((item) => item.severity === "warning").length, "warning")
  }${total !== undefined && total > items.length ? ` · ${items.length} of ${total} shown` : ""}`

/*
 * The language server as the card knows it (payload.intel), stated only when
 * there is something to state: a missing server with its install line
 * verbatim, a host refusal with the host's message, the spawn in progress,
 * and a ready server's one-line note when the seam left one (a definition
 * that lies outside the repository). `ready` with no note renders nothing —
 * absence is the state.
 */
const CodeIntelNote = ({ intel, language }: {
  readonly intel: NonNullable<Extract<Card, { kind: "file" }>["payload"]["intel"]>
  readonly language: string | null
}) => {
  const server = `${language === null ? "" : `${language} `}language server`
  if (intel.state === "ready") return intel.note === undefined ? null : <p className="code-intel-note" data-intel="ready">{intel.note}</p>
  if (intel.state === "starting") return <p className="code-intel-note" data-intel="starting">Starting the {server}…</p>
  if (intel.state === "missing") {
    return (
      <p className="code-intel-note" data-intel="missing">
        Hover and definitions: no {server} on this machine.
        {intel.note === undefined ? null : (
          <>
            <br />
            Install: <code>{intel.note}</code>
          </>
        )}
      </p>
    )
  }
  return <p className="code-intel-note" data-intel="unavailable">Hover and definitions: {intel.note ?? "the language server is unavailable"}</p>
}

/*
 * The editor reseeds its document only when resetKey changes (the adapter's
 * contract), so the key follows the CONTENT: a re-read after a same-length
 * edit must not show the old text. djb2 over the string is cheap at the card
 * cap and distinct enough for a key.
 */
export const contentKey = (content: string): string => {
  let hash = 5381
  for (let index = 0; index < content.length; index += 1) hash = ((hash << 5) + hash + content.charCodeAt(index)) | 0
  return `${content.length}:${(hash >>> 0).toString(36)}`
}

export interface FileCardActions {
  readonly onRunCommand: RunCommand
}

/** The entry's full path under the card's path — the argument the row's command takes. */
const childPath = (parent: string, name: string): string => parent === "" ? name : `${parent}/${name}`

/*
 * The card's address header (lane piper step 5, ADR 0001): the global path
 * `/org/repo/path` the payload carries, plus the position the read was taken
 * at, plus — when the inventory says the repository's head has moved since —
 * a "head moved to <id> · refresh" line. Nothing auto-refreshes: the card
 * states where it stands; the human (or the model) re-reads explicitly.
 * The controller is read from context directly so component tests without a
 * provider still render the plain address.
 */
const FileCardHeader = (props: {
  readonly repo: string
  readonly localRepoId?: string | undefined
  readonly path: string
  readonly address?: string | undefined
  readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null; readonly source?: "head" | "working-copy" | undefined } | undefined
  readonly refreshCommand: "files.read" | "files.list"
  readonly onRunCommand: RunCommand
  readonly trailing?: ReactNode
}) => {
  const controller = useContext(ControllerContext)
  if (controller === null) return <FileCardAddressLine {...props} head={null} />
  return <FileCardHeaderLive {...props} controller={controller} />
}

export const FileCardAddressLine = ({
  repo,
  localRepoId,
  path,
  address,
  readAt,
  head,
  refreshCommand,
  onRunCommand,
  trailing
}: {
  readonly repo: string
  readonly localRepoId?: string | undefined
  readonly path: string
  readonly address?: string | undefined
  readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null; readonly source?: "head" | "working-copy" | undefined } | undefined
  readonly head: { readonly changeId: string | null; readonly commitId: string | null } | null
  readonly refreshCommand: "files.read" | "files.list"
  readonly onRunCommand: RunCommand
  /** Rendered at the end of the address line: the file card's language word. */
  readonly trailing?: ReactNode
}) => {
  // A working-copy read is pinned at the checkout's `@`, which is not the head by design: its drift is the origin chip's "N ahead", never "head moved".
  const moved = readAt?.source !== "working-copy" && head !== null && readAt?.commitId != null && head.commitId != null &&
    head.commitId !== readAt.commitId
  const refreshArgs = fileArgs(path === "" ? "/" : path, localRepoId ?? repo)
  return (
    <div>
      <p className="world-card-path">
        {address ?? `${repo} · ${path || "/"}`}
        {readAt?.changeId != null ? ` · ${shortId(readAt.changeId)}` : null}
        {trailing == null ? null : <span className="world-card-path-trailing">{trailing}</span>}
      </p>
      {moved ?
        (
          <p className="world-card-empty">
            head moved to {shortId(head.changeId ?? head.commitId ?? "")}
            {" · "}
            <Button
              variant="ghost"
              size="sm"
              data-flow={refreshCommand}
              onClick={() => onRunCommand(refreshCommand, refreshArgs)}
            >
              refresh
            </Button>
          </p>
        ) :
        null}
    </div>
  )
}

const FileCardHeaderLive = ({
  controller,
  ...props
}: {
  readonly controller: AppController
  readonly repo: string
  readonly localRepoId?: string | undefined
  readonly path: string
  readonly address?: string | undefined
  readonly readAt?: { readonly changeId: string | null; readonly commitId: string | null; readonly source?: "head" | "working-copy" | undefined } | undefined
  readonly refreshCommand: "files.read" | "files.list"
  readonly onRunCommand: RunCommand
  readonly trailing?: ReactNode
}) => {
  const { data: repositoryRows } = useLiveQuery((q) =>
    q.from({ repository: controller.store.collections.repositories }).select(({ repository }) => ({
      id: repository.id,
      head: repository.head
    })))
  const head = repositoryRows.find((row) => row.id === props.repo)?.head ?? null
  return <FileCardAddressLine {...props} head={head} />
}

export const FileListCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "file-list" }> } & FileCardActions) => {
  const { repo, path, entries } = card.payload
  return (
    <div className="world-card-list world-card-panel">
      <FileCardHeader
        repo={repo}
        localRepoId={card.payload.localRepoId}
        path={path}
        address={card.payload.address}
        readAt={card.payload.readAt}
        refreshCommand="files.list"
        onRunCommand={onRunCommand}
      />
      <ul className="world-card-list">
        {entries.length === 0 ?
          (
            <li className="world-card-empty">
              Nothing under {path || "/"} in {repo}.
            </li>
          ) :
          (
            entries.map((entry) => (
              <li key={entry.name} className="world-card-row">
                {entry.kind === "dir" ?
                  (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-flow="files.list"
                      onClick={() => onRunCommand("files.list", fileArgs(childPath(path, entry.name), card.payload.localRepoId ?? repo))}
                    >
                      <Folder size={12} aria-hidden="true" />
                      <span className="world-card-title">{entry.name}</span>
                    </Button>
                  ) :
                  (
                    <Button
                      variant="ghost"
                      size="sm"
                      data-flow="files.read"
                      onClick={() => onRunCommand("files.read", fileArgs(childPath(path, entry.name), card.payload.localRepoId ?? repo))}
                    >
                      <FileText size={12} aria-hidden="true" />
                      <span className="world-card-title">{entry.name}</span>
                    </Button>
                  )}
              </li>
            ))
          )}
      </ul>
      {card.payload.truncated === true ?
        <p className="world-card-empty">Truncated — the directory holds more entries than the listing shows.</p> :
        null}
    </div>
  )
}

export const FileCardBody = ({
  card,
  onRunCommand
}: { readonly card: Extract<Card, { kind: "file" }> } & FileCardActions) => {
  const language = languageWord(card.payload.path)
  /*
   * The gestures follow the catalog (THE THREE-DOOR LAW): the surface binds
   * code.hover / code.definition only where this host registers them. The
   * web host lacks the `local.lsp` door, so there the card states the door
   * once, under the header, on exactly the files a language server would
   * serve — the pointer path drops an unregistered name silently, and a
   * gesture that does nothing is a dead control. Without a controller (a
   * component test) the caller's onRunCommand is the whole door.
   */
  const controller = useContext(ControllerContext)
  const codeIntel = controller === null || controller.commands.find("code.hover") !== undefined
  const absent = codeIntel ? undefined : controller?.commands.explainAbsent("code.hover")
  const text = card.payload.binary !== true && !isMarkdownPath(card.payload.path)
  const intel = card.payload.intel ??
    (absent !== undefined && text && lspLanguageFor(card.payload.path) !== null ? { state: "unavailable" as const, note: absent.reason } : undefined)
  return (
    /*
     * Ask 6 (will, 2026-09-02): the body is a PANEL — capped height, its own
     * scrollbar (styles/cards.css `.world-card-panel`) — so a long file scrolls
     * inside the card instead of turning the transcript into the file.
     */
    <div className="world-card-list world-card-panel" data-line={card.payload.line}>
      <FileCardHeader
        repo={card.payload.repo}
        localRepoId={card.payload.localRepoId}
        path={card.payload.path}
        address={card.payload.address}
        readAt={card.payload.readAt}
        refreshCommand="files.read"
        onRunCommand={onRunCommand}
        trailing={language === null ? undefined : <span data-slot="code-language">{language}</span>}
      />
      {/* Code intelligence (docs/code-intel/PLAN.md §5): the count once the server answered; the server's state when it is not ready. */}
      {card.payload.diagnostics === undefined ? null : (
        <p
          className="code-diagnostics-count"
          data-slot="code-diagnostics-count"
          data-errors={card.payload.diagnostics.filter((item) => item.severity === "error").length}
        >
          {diagnosticsCount(card.payload.diagnostics, card.payload.diagnosticsTotal)}
        </p>
      )}
      {intel === undefined ? null : <CodeIntelNote intel={intel} language={language} />}
      {card.payload.binary === true ?
        (
          <p className="world-card-empty">
            This file is binary, so its bytes are not shown here — open it in the repository.
          </p>
        ) :
        isMarkdownPath(card.payload.path) ?
        (
          <div className="world-card-doc" data-file-markdown="">
            <Suspense fallback={<p className="smithers-card-note">Loading editor…</p>}>
              <MarkdownEditorSurface
                value={card.payload.content}
                resetKey={`${card.id}:${contentKey(card.payload.content)}`}
                label={`${card.payload.path} in ${card.payload.repo}`}
                readOnly
              />
            </Suspense>
          </div>
        ) :
        /*
         * A cut file is still code (will, 2026-09-03: a 16 KiB TypeScript file
         * rendered monochrome was the complaint). The prefix is highlighted and
         * the truncation line below states the cut; at most the last token is
         * split, and the language server reads the file from disk, not the card.
         */
        (
          <Suspense fallback={<pre className="world-card-path">{card.payload.content}</pre>}>
            <CodeSurface payload={card.payload} codeIntel={codeIntel} onRunCommand={onRunCommand} />
          </Suspense>
        )}
      {card.payload.truncated ?
        <p className="world-card-empty">Truncated — the full file stays in the repository.</p> :
        null}
    </div>
  )
}

export const fileCardFamily: CardFamily<"file-list" | "file"> = {
  "file-list": {
    render: (card, actions) => <FileListCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  },
  file: {
    render: (card, actions) => <FileCardBody card={card} onRunCommand={actions.onRunCommand} />,
    pill: settledPill
  }
}
