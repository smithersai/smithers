import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useAgentClis() {
  return useQuery({
    queryKey: ["agent-clis"],
    queryFn: () => burnsClient.listAgentClis(),
  })
}
