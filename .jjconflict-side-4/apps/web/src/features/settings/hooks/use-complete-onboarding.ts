import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useCompleteOnboarding() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => burnsClient.completeOnboarding(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["onboarding-status"] })
    },
  })
}
