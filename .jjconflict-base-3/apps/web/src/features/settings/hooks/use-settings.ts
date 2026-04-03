import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () => burnsClient.getSettings(),
  })
}
