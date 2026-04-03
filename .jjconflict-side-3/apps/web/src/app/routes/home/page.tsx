import { Navigate } from "react-router-dom"

import { useOnboardingStatus } from "@/features/settings/hooks/use-onboarding-status"
import { shouldShowOnboarding } from "@/features/settings/lib/form"
import { useWorkspaces } from "@/features/workspaces/hooks/use-workspaces"

export function HomePage() {
  const { data: workspaces = [], isLoading: isLoadingWorkspaces } = useWorkspaces()
  const { data: onboardingStatus, isLoading: isLoadingOnboarding } = useOnboardingStatus()

  if (isLoadingWorkspaces || isLoadingOnboarding) {
    return <div className="p-6 text-sm text-muted-foreground">Loading workspaces…</div>
  }

  if (workspaces[0]) {
    return <Navigate to={`/w/${workspaces[0].id}/overview`} replace />
  }

  if (shouldShowOnboarding({ workspacesCount: workspaces.length, onboardingCompleted: Boolean(onboardingStatus?.completed) })) {
    return <Navigate to="/onboarding" replace />
  }

  return <Navigate to="/workspaces/new" replace />
}
