import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useWorkflowFiles(workspaceId?: string, workflowId?: string) {
  return useQuery({
    queryKey: ["workflow-files", workspaceId, workflowId],
    queryFn: () => burnsClient.listWorkflowFiles(workspaceId!, workflowId!),
    enabled: Boolean(workspaceId && workflowId),
  })
}
