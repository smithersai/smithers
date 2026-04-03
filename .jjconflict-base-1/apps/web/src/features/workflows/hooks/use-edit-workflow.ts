import type { EditWorkflowInput, WorkflowAuthoringStatusEvent } from "@burns/shared"

import { useCallback, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"
import {
  applyWorkflowAuthoringStreamEvent,
  createInitialWorkflowAuthoringConversationState,
  finalizeWorkflowAuthoringConversationState,
} from "@/features/workflows/lib/workflow-authoring-conversation"

export function useEditWorkflow(workspaceId?: string, workflowId?: string) {
  const queryClient = useQueryClient()
  const [statusUpdates, setStatusUpdates] = useState<WorkflowAuthoringStatusEvent[]>([])
  const [conversationState, setConversationState] = useState(
    createInitialWorkflowAuthoringConversationState
  )
  const abortControllerRef = useRef<AbortController | null>(null)

  const mutation = useMutation({
    mutationFn: async (input: EditWorkflowInput) => {
      const controller = new AbortController()
      abortControllerRef.current = controller

      return burnsClient.editWorkflowStream(workspaceId!, workflowId!, input, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "status") {
            setStatusUpdates((previous) => [...previous, event])
          }

          setConversationState((previous) =>
            applyWorkflowAuthoringStreamEvent(previous, event)
          )
        },
      })
    },
    onMutate: () => {
      setStatusUpdates([])
      setConversationState(createInitialWorkflowAuthoringConversationState())
    },
    onSuccess: async (workflow) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["workflows", workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["workflow", workspaceId, workflow.id] }),
        queryClient.invalidateQueries({ queryKey: ["workflow-files", workspaceId, workflow.id] }),
        queryClient.invalidateQueries({ queryKey: ["workflow-file", workspaceId, workflow.id] }),
        queryClient.invalidateQueries({
          queryKey: ["workflow-launch-fields", workspaceId, workflow.id],
        }),
      ])
    },
    onSettled: () => {
      setConversationState((previous) => finalizeWorkflowAuthoringConversationState(previous))
      abortControllerRef.current = null
    },
  })

  const cancel = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  return {
    ...mutation,
    cancel,
    statusUpdates,
    conversationItems: conversationState.items,
  }
}
