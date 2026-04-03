import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useWorkflowFile(workspaceId?: string, workflowId?: string, filePath?: string) {
  return useQuery({
    queryKey: ["workflow-file", workspaceId, workflowId, filePath],
    queryFn: () => burnsClient.getWorkflowFile(workspaceId!, workflowId!, filePath!),
    enabled: Boolean(workspaceId && workflowId && filePath),
  })
}
