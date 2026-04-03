import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useRun(workspaceId?: string, runId?: string) {
  return useQuery({
    queryKey: ["run", workspaceId, runId],
    queryFn: () => burnsClient.getRun(workspaceId!, runId!),
    enabled: Boolean(workspaceId && runId),
    refetchInterval: 5000,
  })
}
