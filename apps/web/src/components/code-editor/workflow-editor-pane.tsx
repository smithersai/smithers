import type { WorkflowDocument } from "@burns/shared"
import { PencilIcon, SaveIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useSaveWorkflow } from "@/features/workflows/hooks/use-save-workflow"

export function WorkflowEditorPane({
  workflow,
  sourceOverride,
  fileName = "workflow.tsx",
  filePath,
  readOnly = false,
  workspaceId,
  workflowId,
  onDirtyChange,
}: {
  workflow: WorkflowDocument | null
  sourceOverride?: string | null
  fileName?: string
  filePath?: string
  readOnly?: boolean
  workspaceId?: string
  workflowId?: string
  onDirtyChange?: (isDirty: boolean) => void
}) {
  const source = sourceOverride ?? workflow?.source ?? null
  const selectedFilePath = filePath ?? fileName
  const saveWorkflow = useSaveWorkflow(workspaceId, workflowId)
  const [isEditing, setIsEditing] = useState(false)
  const [draftSource, setDraftSource] = useState("")
  const canEdit = Boolean(source && workspaceId && workflowId && selectedFilePath && !readOnly)
  const isDirty = isEditing && draftSource !== (source ?? "")

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  useEffect(
    () => () => {
      onDirtyChange?.(false)
    },
    [onDirtyChange]
  )

  const startEditing = () => {
    if (!source || !canEdit) {
      return
    }

    setDraftSource(source)
    setIsEditing(true)
  }

  const cancelEditing = () => {
    setDraftSource(source ?? "")
    setIsEditing(false)
  }

  const saveEdits = useCallback(() => {
    if (!canEdit) {
      return
    }

    saveWorkflow.mutate(
      { source: draftSource, filePath: selectedFilePath },
      {
        onSuccess: () => {
          setIsEditing(false)
        },
      }
    )
  }, [canEdit, draftSource, saveWorkflow, selectedFilePath])

  useEffect(() => {
    if (!isEditing) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        if (isDirty && !saveWorkflow.isPending) {
          saveEdits()
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isDirty, isEditing, saveEdits, saveWorkflow.isPending])

  return (
    <div className="m-0 flex min-h-0 flex-1 flex-col py-2 pl-0 pr-2 xl:h-full xl:min-h-0">
      <div className="flex flex-1 flex-col gap-3 overflow-hidden px-0 xl:min-h-0">
        {source ? (
          isEditing ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-background text-foreground">
              <div className="flex items-center justify-between border-b bg-muted/80 px-3 py-2 text-muted-foreground text-xs">
                <div className="flex items-center gap-2 font-mono">{fileName}</div>
                <div className="flex items-center gap-1">
                  <Button aria-label="Cancel edits" size="icon-sm" variant="ghost" onClick={cancelEditing}>
                    <XIcon />
                  </Button>
                  <Button
                    aria-label="Save edits"
                    size="icon-sm"
                    variant="ghost"
                    disabled={saveWorkflow.isPending || !isDirty}
                    onClick={saveEdits}
                  >
                    <SaveIcon />
                  </Button>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col p-3">
                <Textarea
                  className="min-h-0 flex-1 rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-0"
                  value={draftSource}
                  onChange={(event) => setDraftSource(event.target.value)}
                  spellCheck={false}
                />
                {saveWorkflow.error ? (
                  <p className="mt-3 text-sm text-destructive">{saveWorkflow.error.message}</p>
                ) : null}
              </div>
            </div>
          ) : (
            <CodeBlock
              className="min-h-0 flex-1 [&_code]:text-xs [&_pre]:text-xs"
              code={source}
              language="tsx"
              showLineNumbers
            >
              <CodeBlockHeader>
                <CodeBlockTitle>
                  <CodeBlockFilename>{fileName}</CodeBlockFilename>
                </CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockCopyButton aria-label="Copy source" size="icon-sm" />
                  {canEdit ? (
                    <Button aria-label="Edit source" size="icon-sm" variant="ghost" onClick={startEditing}>
                      <PencilIcon />
                    </Button>
                  ) : null}
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          )
        ) : (
          <div className="flex h-full min-h-0 items-center justify-center rounded-xl border px-6 text-sm text-muted-foreground">
            Select a file to preview highlighted source.
          </div>
        )}
      </div>
    </div>
  )
}
