import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useWorkspaces() {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: () => burnsClient.listWorkspaces(),
  })
}
