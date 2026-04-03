import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useApprovals(workspaceId?: string) {
  return useQuery({
    queryKey: ["approvals", workspaceId],
    queryFn: () => burnsClient.listApprovals(workspaceId!),
    enabled: Boolean(workspaceId),
  })
}
