import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useResetSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => burnsClient.resetSettings(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding-status"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-server-status"] }),
      ])
    },
  })
}
