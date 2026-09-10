import { fileArgs } from "../flows/FileArgs"
/*
 * The highlighted file body (docs/code-intel/PLAN.md §1, §5): `@pierre/diffs`
 * `File` through `@smthrs/ui/adapters/code-view`, Shiki underneath. The
 * adapter is heavy, so FileCards loads this module lazily: it is the async
 * chunk boundary and stays the only place in the app graph that imports the
 * adapter. A file no grammar claims keeps the card's own plain block.
 *
 * Code intelligence rides the same surface and the payload alone: the
 * diagnostics the seam wrote render under their lines, the last hover
 * answer renders under its line, and the two pointer gestures are command
 * bindings through onRunCommand — a pointer at rest on a token runs
 * `code.hover <path>:<line>:<col> <repo>`, ⌘/Ctrl-click runs
 * `code.definition` with the same position — the same door every row in
 * FileCards.tsx uses, so the slash and the agent tool run the identical act.
 * The gestures bind only where those flows exist (`codeIntel`, the card's
 * reading of the catalog): a host without `local.lsp` renders the same
 * highlighted file with no dead gesture. Nothing here is component state;
 * the one ref is the position last asked, so a pointer that stays put asks
 * once.
 */
import { LSP_HOVER_CAP_CHARS } from "@smthrs/rpc/LocalApp"
import { Markdown } from "@smthrs/ui"
import { CodeFileView, languageForFile } from "@smthrs/ui/adapters/code-view"
import type { CodeLineAnnotation, CodeTokenPosition } from "@smthrs/ui/adapters/code-view"
import { useMemo, useRef } from "react"
import type { Card } from "../state/AppState"
import type { RunCommand } from "./CardFamily"

type FilePayload = Extract<Card, { kind: "file" }>["payload"]
type Diagnostic = NonNullable<FilePayload["diagnostics"]>[number]

/** The mark before a diagnostic's message; the mockup's `✖` for an error, its counterpart for a warning, a dot for the rest. */
const SEVERITY_GLYPH: Readonly<Record<Diagnostic["severity"], string>> = { error: "✖", warning: "▲", information: "·", hint: "·" }

const DiagnosticRow = ({ item }: { readonly item: Diagnostic }) => {
  const origin = [item.source, item.code].filter((part): part is string => part !== undefined).join(" ")
  return (
    <p className="code-diagnostic" data-slot="code-diagnostic" data-severity={item.severity}>
      <span className="code-diagnostic-glyph" aria-hidden="true">{SEVERITY_GLYPH[item.severity]}</span>
      <span className="code-diagnostic-message">{item.message}</span>
      {origin === "" ? null : <span className="code-diagnostic-origin">({origin})</span>}
    </p>
  )
}

/** The modifier the definition gesture takes on this machine, as the hover box names it. */
const activateKey = (): string => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘-click" : "Ctrl-click")

/** The host cut the server's text at its cap: the box says so rather than ending mid-sentence as if complete. */
const HOVER_CUT = `(cut at ${LSP_HOVER_CAP_CHARS / 1024} KiB)`

const HoverBox = ({ contents, truncated }: { readonly contents: string; readonly truncated: boolean }) => (
  <div className="code-hover" data-slot="code-hover">
    <Markdown className="code-hover-body" content={contents} />
    {truncated ? <span className="code-hover-hint" data-slot="code-hover-cut">{HOVER_CUT}</span> : null}
    <span className="code-hover-hint">{activateKey()}: definition</span>
  </div>
)

export const CodeSurface = ({
  payload,
  codeIntel,
  onRunCommand
}: {
  readonly payload: FilePayload
  /** Whether this host registers the code.* flows (FileCards reads the catalog); false binds no gesture. */
  readonly codeIntel: boolean
  readonly onRunCommand: RunCommand
}) => {
  const { path, content, line, repo, hover, diagnostics, intel } = payload

  const annotations = useMemo<ReadonlyArray<CodeLineAnnotation>>(
    () => [
      ...(diagnostics ?? []).map((item, index) => ({ key: `diagnostic-${index}`, line: item.line, node: <DiagnosticRow item={item} /> })),
      ...(hover == null ? [] : [{ key: "hover", line: hover.line, node: <HoverBox contents={hover.contents} truncated={hover.truncated === true} /> }])
    ],
    [diagnostics, hover]
  )

  /*
   * One hover in flight: the position last asked, with the payload it was
   * asked against. The same position is not asked again until the payload
   * has moved (the answer landed, or anything else patched the card); a
   * position the payload already answers is never asked.
   */
  const asked = useRef<{ readonly key: string; readonly payload: FilePayload } | null>(null)
  const position = (token: CodeTokenPosition): string => fileArgs(`${path}:${token.line}:${token.column}`, payload.localRepoId ?? repo)
  const onTokenRest = (token: CodeTokenPosition): void => {
    const key = `${token.line}:${token.column}`
    if (hover != null && hover.line === token.line && hover.character === token.column) return
    if (asked.current !== null && asked.current.key === key && asked.current.payload === payload) return
    asked.current = { key, payload }
    onRunCommand("code.hover", position(token))
  }
  const onTokenActivate = (token: CodeTokenPosition): void => onRunCommand("code.definition", position(token))

  if (languageForFile(path) === null) return <pre className="world-card-path">{content}</pre>
  /*
   * A host without the flows, or a card that already knows there is no
   * server to ask (the note under the header states it, with the install
   * line), binds no gesture: every rest would be one more refusal — or, on
   * a host that drops an unregistered name, nothing at all.
   */
  const bound = codeIntel && intel?.state !== "missing" && intel?.state !== "unavailable"
  return (
    <div className="code-surface" data-flow={bound ? "code.hover" : undefined} data-flow-activate={bound ? "code.definition" : undefined}>
      <CodeFileView
        name={path}
        contents={content}
        line={line}
        annotations={annotations}
        onTokenRest={bound ? onTokenRest : undefined}
        onTokenActivate={bound ? onTokenActivate : undefined}
      />
    </div>
  )
}
