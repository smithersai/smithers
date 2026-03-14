import { CheckIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block"
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
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useAgentClis } from "@/features/agents/hooks/use-agent-clis"
import { useActiveWorkspace } from "@/features/workspaces/hooks/use-active-workspace"
import { WorkflowAuthoringConversationPanel } from "@/features/workflows/components/workflow-authoring-conversation-panel"
import { useGenerateWorkflow } from "@/features/workflows/hooks/use-generate-workflow"
import { canEditWorkspaceWorkflows } from "@/features/workflows/lib/access"

export function NewWorkflowPage() {
  const navigate = useNavigate()
  const { workspace, workspaceId } = useActiveWorkspace()
  const { data: agentClis = [], isLoading: isAgentListLoading } = useAgentClis()
  const generateWorkflow = useGenerateWorkflow(workspace?.id)
  const canEditWorkflows = canEditWorkspaceWorkflows(workspace)

  const [name, setName] = useState("issue-to-pr")
  const [prompt, setPrompt] = useState(
    "Create a workflow that takes an issue description, proposes a plan, implements the change, validates it, and summarizes the result."
  )
  const [selectedAgentId, setSelectedAgentId] = useState<string>("")
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false)

  const resolvedSelectedAgentId = selectedAgentId || agentClis[0]?.id || ""
  const lastNavigatedWorkflowIdRef = useRef<string | null>(null)

  const selectedAgent = useMemo(
    () => agentClis.find((agent) => agent.id === resolvedSelectedAgentId) ?? null,
    [agentClis, resolvedSelectedAgentId]
  )

  const generatedWorkflow = generateWorkflow.data ?? null

  const submitStatus = generateWorkflow.isPending ? "streaming" : "ready"
  const errorMessage =
    generateWorkflow.error?.message === "[object Object]"
      ? "Workflow generation failed with a malformed error payload. Check daemon logs for details."
      : generateWorkflow.error?.message ?? null

  function handleAgentSubmit(message: PromptInputMessage) {
    if (!workspace || !resolvedSelectedAgentId) {
      return
    }

    const submittedPrompt = message.text?.trim() || prompt.trim()
    if (!submittedPrompt) {
      return
    }

    setPrompt(submittedPrompt)
    generateWorkflow.mutate({
      name,
      agentId: resolvedSelectedAgentId,
      prompt: submittedPrompt,
    })
  }

  useEffect(() => {
    if (!generatedWorkflow || generateWorkflow.isPending) {
      return
    }

    if (lastNavigatedWorkflowIdRef.current === generatedWorkflow.id) {
      return
    }

    lastNavigatedWorkflowIdRef.current = generatedWorkflow.id
    if (!workspaceId) {
      return
    }
    navigate(`/w/${workspaceId}/workflows/${generatedWorkflow.id}`, { replace: true })
  }, [generatedWorkflow, generateWorkflow.isPending, navigate, workspaceId])

  if (!canEditWorkflows) {
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden">
        <div className="grid gap-4 p-6">
          <Card>
            <CardHeader>
              <CardTitle>Workflow generator</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Self-managed workspaces are read-only in Burns. Use the source repository to create or modify workflows, and Burns will discover them here.
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden xl:overflow-y-hidden">
      <div className="grid w-full min-w-0 max-w-full gap-4 p-6 xl:h-full xl:min-h-0 xl:grid-cols-[28rem_1fr] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
        <Card className="min-w-0 xl:flex xl:min-h-0 xl:flex-col">
          <CardHeader>
            <CardTitle>Workflow generator</CardTitle>
          </CardHeader>
          <CardContent className="xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="workflow-name">Workflow name</FieldLabel>
                <Input
                  id="workflow-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel>Workflow prompt</FieldLabel>
                <PromptInput onSubmit={handleAgentSubmit}>
                  <PromptInputBody>
                    <PromptInputTextarea
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      placeholder="Describe the workflow you want to generate"
                    />
                  </PromptInputBody>
                  <PromptInputFooter>
                    <PromptInputTools className="min-w-0 flex-1">
                      <ModelSelector
                        open={isModelSelectorOpen}
                        onOpenChange={setIsModelSelectorOpen}
                      >
                        <ModelSelectorTrigger
                          render={
                            <PromptInputButton className="max-w-full justify-start overflow-hidden" size="sm" />
                          }
                        >
                          {selectedAgent ? (
                            <>
                              <ModelSelectorLogo provider={selectedAgent.logoProvider} />
                              <ModelSelectorName className="truncate">
                                {selectedAgent.name}
                              </ModelSelectorName>
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
                      disabled={!name.trim() || !prompt.trim() || !resolvedSelectedAgentId || isAgentListLoading}
                      onStop={generateWorkflow.cancel}
                      status={submitStatus}
                    />
                  </PromptInputFooter>
                </PromptInput>
              </Field>

              {errorMessage ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {errorMessage}
                </div>
              ) : null}
            </FieldGroup>
          </CardContent>
        </Card>

        <div className="grid min-w-0 gap-4 xl:h-full xl:min-h-0">
          <Card className="min-w-0 xl:flex xl:min-h-0 xl:flex-col">
            <CardHeader>
              <CardTitle>Generated workflow</CardTitle>
            </CardHeader>
            <CardContent className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden xl:min-h-0">
              {generateWorkflow.isPending ? (
                <WorkflowAuthoringConversationPanel
                  isStreaming={generateWorkflow.isPending}
                  items={generateWorkflow.conversationItems}
                />
              ) : generatedWorkflow ? (
                <CodeBlock
                  className="flex-1 min-h-0"
                  code={generatedWorkflow.source}
                  language="tsx"
                  showLineNumbers
                >
                  <CodeBlockHeader>
                    <CodeBlockTitle>
                      <CodeBlockFilename>workflow.tsx</CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions>
                      <CodeBlockCopyButton />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                </CodeBlock>
              ) : (
                <div className="flex h-full min-h-0 items-center justify-center rounded-xl border px-6 text-sm text-muted-foreground">
                  Submit a workflow prompt to generate. The preview updates when generation completes.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
