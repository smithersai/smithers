import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"
import type { RuntimeContext } from "@burns/shared"

export function useRuntimeContext() {
  return useQuery({
    queryKey: ["runtime-context", "v3"],
    queryFn: (): Promise<RuntimeContext> => burnsClient.getRuntimeContext(),
    staleTime: 5 * 60_000,
    retry: false,
  })
}
