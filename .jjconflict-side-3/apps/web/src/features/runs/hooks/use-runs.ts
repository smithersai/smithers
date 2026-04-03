import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useRuns(workspaceId?: string) {
  return useQuery({
    queryKey: ["runs", workspaceId],
    queryFn: () => burnsClient.listRuns(workspaceId!),
    enabled: Boolean(workspaceId),
    refetchInterval: 5000,
  })
}
