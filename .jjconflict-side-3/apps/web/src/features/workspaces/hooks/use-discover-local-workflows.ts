import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useDiscoverLocalWorkflows(localPath?: string, enabled = true) {
  return useQuery({
    queryKey: ["local-workflows", localPath],
    queryFn: () => burnsClient.discoverLocalWorkflows(localPath!),
    enabled: enabled && Boolean(localPath),
  })
}
