import { useQuery } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useOnboardingStatus() {
  return useQuery({
    queryKey: ["onboarding-status"],
    queryFn: () => burnsClient.getOnboardingStatus(),
  })
}
