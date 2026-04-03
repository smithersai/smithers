import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useWorkflows(workspaceId?: string) {
  return useQuery({
    queryKey: ["workflows", workspaceId],
    queryFn: () => burnsClient.listWorkflows(workspaceId!),
    enabled: Boolean(workspaceId),
  })
}
