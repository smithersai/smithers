import { CheckIcon } from "lucide-react"
import type { ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"
import { useBlocker, useNavigate, useParams, useSearchParams } from "react-router-dom"

import { FileTree, FileTreeFile, FileTreeFolder } from "@/components/ai-elements/file-tree"
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector"
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input"
import { WorkflowEditorPane } from "@/components/code-editor/workflow-editor-pane"
import { Card, CardContent } from "@/components/ui/card"
import { useAgentClis } from "@/features/agents/hooks/use-agent-clis"
import { WorkflowAuthoringConversationPanel } from "@/features/workflows/components/workflow-authoring-conversation-panel"
import { useEditWorkflow } from "@/features/workflows/hooks/use-edit-workflow"
import { useWorkflowFile } from "@/features/workflows/hooks/use-workflow-file"
import { useWorkflowFiles } from "@/features/workflows/hooks/use-workflow-files"
import { useWorkflow } from "@/features/workflows/hooks/use-workflow"
import { useWorkflows } from "@/features/workflows/hooks/use-workflows"
import { canEditWorkspaceWorkflows } from "@/features/workflows/lib/access"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"

type WorkflowTreeNode =
  | {
      type: "folder"
      name: string
      path: string
      children: WorkflowTreeNode[]
    }
  | {
      type: "file"
      name: string
      path: string
    }

function normalizeRelativePath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "")
}

function createSortedTree(nodes: WorkflowTreeNode[]): WorkflowTreeNode[] {
  return [...nodes]
    .map((node) =>
      node.type === "folder"
        ? {
            ...node,
            children: createSortedTree(node.children),
          }
        : node
    )
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === "folder" ? -1 : 1
      }

      return left.name.localeCompare(right.name)
    })
}

function buildWorkflowTree(filePaths: string[]): WorkflowTreeNode[] {
  const rootNodes: WorkflowTreeNode[] = []

  for (const filePath of filePaths) {
    const normalizedPath = normalizeRelativePath(filePath)
    const segments = normalizedPath.split("/").filter(Boolean)
    if (segments.length === 0) {
      continue
    }

    let currentNodes = rootNodes
    let currentPath = ""

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      const isLeaf = index === segments.length - 1

      const existingNode = currentNodes.find((node) => node.path === currentPath)
      if (existingNode) {
        if (existingNode.type === "folder") {
          currentNodes = existingNode.children
        }
        continue
      }

      if (isLeaf) {
        currentNodes.push({
          type: "file",
          name: segment,
          path: currentPath,
        })
      } else {
        const folderNode: WorkflowTreeNode = {
          type: "folder",
          name: segment,
          path: currentPath,
          children: [],
        }
        currentNodes.push(folderNode)
        currentNodes = folderNode.children
      }
    }
  }

  return createSortedTree(rootNodes)
}

function getRequiredExpandedPaths(path: string | undefined) {
  if (!path) {
    return new Set<string>()
  }

  const segments = path.split("/").filter(Boolean)
  const expanded = new Set<string>()
  let current = ""
  for (const segment of segments.slice(0, -1)) {
    current = current ? `${current}/${segment}` : segment
    expanded.add(current)
  }
  return expanded
}

function renderTreeNode(node: WorkflowTreeNode): ReactNode {
  if (node.type === "folder") {
    return (
      <FileTreeFolder key={node.path} path={node.path} name={node.name}>
        {node.children.map((childNode) => renderTreeNode(childNode))}
      </FileTreeFolder>
    )
  }

  return <FileTreeFile key={node.path} path={node.path} name={node.name} />
}

export function WorkflowDetailPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { workflowId } = useParams()
  const { workspace, workspaceId } = useActiveWorkspace()
  const { data: agentClis = [], isLoading: isAgentListLoading } = useAgentClis()
  const { data: workflows = [], isLoading: isWorkflowListLoading } = useWorkflows(workspace?.id)
  const { data: workflowDocument } = useWorkflow(workspace?.id, workflowId)
  const editWorkflow = useEditWorkflow(workspace?.id, workflowId)
  const workflowFilesQuery = useWorkflowFiles(workspace?.id, workflowId)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(["__workflow_root__"]))
  const [prompt, setPrompt] = useState(
    "Update this workflow to add an approval gate before deploy and preserve stable task IDs."
  )
  const [selectedAgentId, setSelectedAgentId] = useState<string>("")
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false)
  const [hasUnsavedEditorChanges, setHasUnsavedEditorChanges] = useState(false)
  const canEditWorkflows = canEditWorkspaceWorkflows(workspace)

  const workflowsBasePath = workspaceId ? `/w/${workspaceId}/workflows` : "/"
  const resolvedSelectedAgentId = selectedAgentId || agentClis[0]?.id || ""
  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === workflowId) ?? null,
    [workflowId, workflows]
  )
  const selectedAgent = useMemo(
    () => agentClis.find((agent) => agent.id === resolvedSelectedAgentId) ?? null,
    [agentClis, resolvedSelectedAgentId]
  )
  const workflowFiles = workflowFilesQuery.data?.files
  const workflowFilePaths = useMemo(
    () => (workflowFiles ?? []).map((file) => normalizeRelativePath(file.path)),
    [workflowFiles]
  )
  const availableWorkflowFilePaths = useMemo(
    () => new Set(workflowFilePaths),
    [workflowFilePaths]
  )
  const treeNodes = useMemo(() => buildWorkflowTree(workflowFilePaths), [workflowFilePaths])
  const selectedPath = useMemo(() => {
    if (workflowFilePaths.length === 0) {
      return undefined
    }

    const selectedFileParam = searchParams.get("file")
    if (selectedFileParam) {
      const normalizedSelectedFilePath = normalizeRelativePath(selectedFileParam)
      if (availableWorkflowFilePaths.has(normalizedSelectedFilePath)) {
        return normalizedSelectedFilePath
      }
    }

    if (availableWorkflowFilePaths.has("workflow.tsx")) {
      return "workflow.tsx"
    }

    return workflowFilePaths[0]
  }, [availableWorkflowFilePaths, searchParams, workflowFilePaths])
  const selectedFileQuery = useWorkflowFile(workspace?.id, workflowId, selectedPath)
  const workflowSourceOverride = useMemo(() => {
    if (selectedPath !== "workflow.tsx") {
      return selectedFileQuery.data?.source ?? null
    }

    return editWorkflow.data?.source ?? selectedFileQuery.data?.source ?? workflowDocument?.source ?? null
  }, [editWorkflow.data?.source, selectedFileQuery.data?.source, selectedPath, workflowDocument?.source])
  const requiredExpandedPaths = useMemo(() => getRequiredExpandedPaths(selectedPath), [selectedPath])
  const effectiveExpandedPaths = useMemo(() => {
    const next = new Set(expandedPaths)
    next.add("__workflow_root__")
    for (const path of requiredExpandedPaths) {
      next.add(path)
    }
    return next
  }, [expandedPaths, requiredExpandedPaths])
  const navigationBlocker = useBlocker(hasUnsavedEditorChanges)

  useEffect(() => {
    if (!workflowId || isWorkflowListLoading) {
      return
    }

    if (workflows.every((workflow) => workflow.id !== workflowId)) {
      navigate(workflowsBasePath, { replace: true })
    }
  }, [isWorkflowListLoading, navigate, workflowId, workflows, workflowsBasePath])

  useEffect(() => {
    if (navigationBlocker.state !== "blocked") {
      return
    }

    if (window.confirm("Discard unsaved workflow edits?")) {
      navigationBlocker.proceed()
      return
    }

    navigationBlocker.reset()
  }, [navigationBlocker])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedEditorChanges) {
        return
      }

      event.preventDefault()
      event.returnValue = ""
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [hasUnsavedEditorChanges])

  function handleAgentSubmit(message: PromptInputMessage) {
    if (!workspace || !workflowId || !resolvedSelectedAgentId) {
      return
    }

    const submittedPrompt = message.text?.trim() || prompt.trim()
    if (!submittedPrompt) {
      return
    }

    setPrompt(submittedPrompt)
    editWorkflow.mutate({
      agentId: resolvedSelectedAgentId,
      prompt: submittedPrompt,
    })
  }

  const submitStatus = editWorkflow.isPending ? "streaming" : "ready"
  const errorMessage =
    editWorkflow.error?.message === "[object Object]"
      ? "Workflow edit failed with a malformed error payload. Check daemon logs for details."
      : editWorkflow.error?.message ?? null

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden xl:overflow-y-hidden">
      <div className="grid w-full min-w-0 max-w-full gap-2 p-0 xl:h-full xl:min-h-0 xl:grid-cols-[22rem_1fr] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
        <Card className="m-0 min-w-0 gap-0 overflow-visible rounded-none py-2 pl-2 pr-0 ring-0 xl:flex xl:min-h-0 xl:flex-col">
          <CardContent className="flex flex-col gap-2 overflow-visible px-0 xl:min-h-0 xl:flex-1 xl:overflow-visible">
            <div className="min-h-0 flex-1 overflow-hidden">
              {isWorkflowListLoading || workflowFilesQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading workflow files…</p>
              ) : treeNodes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No workflow files found.</p>
              ) : (
                <FileTree
                  className="h-full min-h-0 overflow-auto"
                  expanded={effectiveExpandedPaths}
                  onExpandedChange={(nextExpanded) => setExpandedPaths(new Set(nextExpanded))}
                  selectedPath={selectedPath}
                  onSelect={(path) => {
                    if (typeof path !== "string") {
                      return
                    }

                    if (!availableWorkflowFilePaths.has(path)) {
                      return
                    }

                    const nextSearch = new URLSearchParams(searchParams)
                    nextSearch.set("file", path)
                    setSearchParams(nextSearch, { replace: true })
                  }}
                >
                  <FileTreeFolder path="__workflow_root__" name={selectedWorkflow?.id ?? "workflow"}>
                    {treeNodes.map((node) => renderTreeNode(node))}
                  </FileTreeFolder>
                </FileTree>
              )}
            </div>

            {canEditWorkflows ? (
              <div className="space-y-2">
                <PromptInput onSubmit={handleAgentSubmit}>
                  <PromptInputBody>
                    <PromptInputTextarea
                      className="min-h-24"
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      placeholder="Describe how this workflow should change"
                    />
                  </PromptInputBody>
                  <PromptInputFooter>
                    <PromptInputTools className="min-w-0 flex-1">
                      <ModelSelector open={isModelSelectorOpen} onOpenChange={setIsModelSelectorOpen}>
                        <ModelSelectorTrigger
                          render={
                            <PromptInputButton
                              className="max-w-full justify-start overflow-hidden"
                              size="sm"
                            />
                          }
                        >
                          {selectedAgent ? (
                            <>
                              <ModelSelectorLogo provider={selectedAgent.logoProvider} />
                              <ModelSelectorName className="truncate">{selectedAgent.name}</ModelSelectorName>
                            </>
                          ) : (
                            <ModelSelectorName>Select agent</ModelSelectorName>
                          )}
                        </ModelSelectorTrigger>
                        <ModelSelectorContent title="Installed agent CLIs">
                          <ModelSelectorInput placeholder="Search installed agent CLIs..." />
                          <ModelSelectorList>
                            <ModelSelectorEmpty>No installed agent CLIs found.</ModelSelectorEmpty>
                            <ModelSelectorGroup heading="Installed agent CLIs">
                              {agentClis.map((agent) => (
                                <ModelSelectorItem
                                  key={agent.id}
                                  value={agent.id}
                                  onSelect={() => {
                                    setSelectedAgentId(agent.id)
                                    setIsModelSelectorOpen(false)
                                  }}
                                >
                                  <ModelSelectorLogo provider={agent.logoProvider} />
                                  <ModelSelectorName>{agent.name}</ModelSelectorName>
                                  {resolvedSelectedAgentId === agent.id ? (
                                    <CheckIcon className="ml-auto" data-icon="inline-end" />
                                  ) : null}
                                </ModelSelectorItem>
                              ))}
                            </ModelSelectorGroup>
                          </ModelSelectorList>
                        </ModelSelectorContent>
                      </ModelSelector>
                    </PromptInputTools>
                    <PromptInputSubmit
                      disabled={
                        !workflowId || !prompt.trim() || !resolvedSelectedAgentId || isAgentListLoading
                      }
                      onStop={editWorkflow.cancel}
                      status={submitStatus}
                    />
                  </PromptInputFooter>
                </PromptInput>
                {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
              </div>
            ) : (
              <p className="px-1 text-sm text-muted-foreground">
                Self-managed workflows are read-only in Burns. You can browse discovered files and run them here, but edit them in the source repository.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="flex min-w-0 flex-col gap-0 xl:min-h-0 xl:overflow-hidden">
          {editWorkflow.isPending ? (
            <Card className="m-0 gap-0 rounded-none py-2 pl-0 pr-2 ring-0 xl:h-full xl:min-h-0 xl:flex xl:flex-col">
              <CardContent className="flex flex-1 flex-col gap-3 overflow-hidden px-0 xl:min-h-0">
                <WorkflowAuthoringConversationPanel
                  isStreaming={editWorkflow.isPending}
                  items={editWorkflow.conversationItems}
                />
              </CardContent>
            </Card>
          ) : (
            <WorkflowEditorPane
              workflow={workflowDocument ?? null}
              sourceOverride={workflowSourceOverride}
              fileName={selectedPath ?? "workflow.tsx"}
              filePath={selectedPath}
              readOnly={!canEditWorkflows}
              workspaceId={workspaceId}
              workflowId={workflowId}
              onDirtyChange={setHasUnsavedEditorChanges}
            />
          )}
        </div>
      </div>
    </div>
  )
}
