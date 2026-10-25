import { CodeEditor, LiveMarkdownEditor } from "@smthrs/repo-view"
import { Button, Card, EmptyState } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useBranch } from "../../branch/components/BranchContext"
import { GeneratedFileWarning } from "../../repo/components/FileMarks"
import { isMarkdownPath } from "../../repo/paths"
import { fileOf, saveLabelOf } from "../view"

const FAILED = { too_large: "Too large", forbidden: "No access", unavailable: "Couldn't open" } as const

// A file of the branch's working copy in the live editor (docs/features/coedit.md#files): everyone with `Can edit`
// types in it at once and sees each other's carets; Save writes it to the working copy. Markdown opens in the Markdown
// editor, anything else in the code editor. Someone who may only view sees it as it is typed.
export function SharedFile({
  conversationId,
  path,
  readOnly,
}: {
  readonly conversationId: string
  readonly path: string
  readonly readOnly: boolean
}) {
  const { coedit } = useBranch()
  const { data: texts } = useLiveQuery(coedit.queries.texts)
  const file = fileOf(texts, conversationId, path)
  return (
    <Card className="shared-file" aria-label={path}>
      <div className="shared-file-bar">
        <span className="shared-file-path">{path}</span>
        {readOnly || file?.status !== "ready" ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={file.saving || file.saved}
            onClick={() => void coedit.actions.save(file.id)}
          >
            {saveLabelOf(file)}
          </Button>
        )}
      </div>
      {file?.status === "ready" && !readOnly ? <GeneratedFileWarning path={path} contents={file.text} /> : null}
      {file === undefined || file.status === "loading" ? null : file.status === "failed" ? (
        <EmptyState title={FAILED[file.failure ?? "unavailable"]} />
      ) : isMarkdownPath(path) ? (
        <LiveMarkdownEditor
          className="shared-file-editor"
          value={file.text}
          readOnly={readOnly}
          aria-label={path}
          onChange={(markdown, { base }) => coedit.actions.type(file.id, markdown, { base })}
        />
      ) : (
        <CodeEditor
          className="shared-file-editor"
          value={file.text}
          readOnly={readOnly}
          aria-label={path}
          collaborators={file.collaborators}
          onChange={(value, edit) => coedit.actions.type(file.id, value, edit)}
          onSelectionChange={(selection) => coedit.actions.select(file.id, selection)}
        />
      )}
    </Card>
  )
}
