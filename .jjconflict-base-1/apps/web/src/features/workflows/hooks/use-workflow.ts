import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useWorkflow(workspaceId?: string, workflowId?: string) {
  return useQuery({
    queryKey: ["workflow", workspaceId, workflowId],
    queryFn: () => burnsClient.getWorkflow(workspaceId!, workflowId!),
    enabled: Boolean(workspaceId && workflowId),
  })
}
