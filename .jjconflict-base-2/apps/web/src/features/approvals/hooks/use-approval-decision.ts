import type { ApprovalDecisionInput } from "@burns/shared"

import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useApprovalDecision(workspaceId?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: {
      runId: string
      nodeId: string
      decision: "approved" | "denied"
      input: ApprovalDecisionInput
    }) => {
      if (params.decision === "approved") {
        return await burnsClient.approveNode(workspaceId!, params.runId, params.nodeId, params.input)
      }

      return await burnsClient.denyNode(workspaceId!, params.runId, params.nodeId, params.input)
    },
    onSuccess: async (approval) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["approvals", workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["runs", workspaceId] }),
        queryClient.invalidateQueries({ queryKey: ["run", workspaceId, approval.runId] }),
        queryClient.invalidateQueries({ queryKey: ["run-events", workspaceId, approval.runId] }),
      ])
    },
  })
}
