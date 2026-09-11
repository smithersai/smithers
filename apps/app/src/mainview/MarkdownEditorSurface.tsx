import { MarkdownEditor, MarkdownEditorStyles } from "@smthrs/ui/adapters/markdown-editor"
import type { MarkdownEditorHandle } from "@smthrs/ui/adapters/markdown-editor"

/**
 * Heavy editor adapter boundary: loaded only when a markdown document is
 * visible — a World note (editable) or a repository's markdown file (read
 * only: no route writes a repository file, so the surface says nothing it
 * cannot do).
 */
export function MarkdownEditorSurface({
  value,
  resetKey,
  label,
  readOnly = false,
  onChange,
  onEditor
}: {
  readonly value: string
  readonly resetKey: string
  readonly label: string
  readonly readOnly?: boolean
  readonly onChange?: (value: string) => void
  /** The editor's imperative handle on mount, null on unmount (the Wiki pane registers it for `wiki.heading`). */
  readonly onEditor?: (editor: MarkdownEditorHandle | null) => void
}) {
  return (
    <>
      <MarkdownEditorStyles />
      <MarkdownEditor
        value={value}
        resetKey={resetKey}
        aria-label={label}
        readOnly={readOnly}
        onChange={onChange ?? (() => {})}
        ref={onEditor}
      />
    </>
  )
}
