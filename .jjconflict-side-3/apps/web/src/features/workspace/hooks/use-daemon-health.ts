import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useDaemonHealth() {
  return useQuery({
    queryKey: ["daemon-health"],
    queryFn: () => burnsClient.getHealth(),
    refetchInterval: 10_000,
  })
}
