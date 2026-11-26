import { Card, DiffHunks, parseUnifiedFile } from "@smthrs/ui"
import type { KeyboardEvent } from "react"
import { changedFileAnchorId, reviewShortcutAction, stepChangedFile } from "../reviewNav"
import type { ChangedFile } from "../schema"
import { fileStatusOf, unifiedOf } from "../view"
import "./changes.css"

// Each file two commits differ by, a card each: its name in a header that stays while its diff scrolls, then the
// diff. Supports keyboard j/k file traversal across changed files without stealing editor focus.
export function ChangedFiles({ files }: { readonly files: ReadonlyArray<ChangedFile> }) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const action = reviewShortcutAction({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      defaultPrevented: event.defaultPrevented,
      isComposing: event.nativeEvent.isComposing,
      ...(target !== null ? { targetTag: target.tagName, targetEditable: target.isContentEditable } : {}),
    })
    if (action === null || action.type === "focusSearch") return
    const currentCard = target?.closest("[data-filename]")
    const activeFilename = currentCard instanceof HTMLElement ? currentCard.getAttribute("data-filename") : null
    const nextFilename = stepChangedFile(files, activeFilename, action.type === "nextFile" ? "next" : "prev")
    if (nextFilename === null) return
    const nextEl = event.currentTarget.querySelector<HTMLElement>(`#${changedFileAnchorId(nextFilename)}`)
    if (nextEl !== null) {
      event.preventDefault()
      nextEl.focus()
      nextEl.scrollIntoView({ block: "nearest" })
    }
  }

  return (
    <div className="changed-files" aria-label="Changed files" onKeyDown={handleKeyDown}>
      {files.map((file) => (
        <Card
          key={file.filename}
          id={changedFileAnchorId(file.filename)}
          data-filename={file.filename}
          tabIndex={0}
          className="changed-file"
        >
          <h3 className="changed-file-name">{file.filename}</h3>
          <DiffHunks file={parseUnifiedFile(unifiedOf(file), { path: file.filename, status: fileStatusOf(file.status) })} />
        </Card>
      ))}
    </div>
  )
}
