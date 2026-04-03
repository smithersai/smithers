import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useCreateWorkspace() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: burnsClient.createWorkspace.bind(burnsClient),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] })
    },
  })
}
