import { useMutation, useQueryClient } from "@tanstack/react-query"

import type { UpdateSettingsInput } from "@burns/shared"

import { burnsClient } from "@/lib/api/client"

export function useUpdateSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => burnsClient.updateSettings(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding-status"] }),
        queryClient.invalidateQueries({ queryKey: ["workspace-server-status"] }),
      ])
    },
  })
}
