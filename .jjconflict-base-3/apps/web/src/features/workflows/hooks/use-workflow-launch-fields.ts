import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useWorkflowLaunchFields(workspaceId?: string, workflowId?: string) {
  return useQuery({
    queryKey: ["workflow-launch-fields", workspaceId, workflowId],
    queryFn: () => burnsClient.getWorkflowLaunchFields(workspaceId!, workflowId!),
    enabled: Boolean(workspaceId && workflowId),
  })
}
