import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useFactoryReset() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => burnsClient.factoryReset(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding-status"] }),
        queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
      ])
    },
  })
}
