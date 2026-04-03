import { createBrowserRouter, Navigate } from "react-router-dom"

import { RouterErrorScreen } from "@/app/components/router-error-screen"
import { AppShell } from "@/app/layouts/app-shell"
import { WorkspaceLayout } from "@/app/layouts/workspace-layout"
import { HomePage } from "@/app/routes/home/page"
import { InboxPage } from "@/app/routes/inbox/page"
import { AddWorkspacePage } from "@/app/routes/add-workspace/page"
import { OnboardingPage } from "@/app/routes/onboarding/page"
import { SettingsPage } from "@/app/routes/settings/page"
import { WorkflowDetailPage } from "@/app/routes/workflows/detail/page"
import { NewWorkflowPage } from "@/app/routes/workflows/new/page"
import { WorkflowsPage } from "@/app/routes/workflows/page"
import { WorkspaceOverviewPage } from "@/app/routes/workspace/overview/page"
import { WorkspaceRunDetailPage } from "@/app/routes/workspace/runs/detail/page"
import { WorkspaceRunsPage } from "@/app/routes/workspace/runs/page"
import { WorkspaceSettingsPage } from "@/app/routes/workspace/settings/page"

export const router = createBrowserRouter([
  {
    path: "/index.html",
    element: <Navigate to="/" replace />,
    errorElement: <RouterErrorScreen />,
  },
  {
    path: "/onboarding",
    element: <OnboardingPage />,
    errorElement: <RouterErrorScreen />,
  },
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouterErrorScreen />,
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      {
        path: "workspaces/new",
        element: <AddWorkspacePage />,
      },
      {
        path: "inbox",
        element: <InboxPage />,
      },
      {
        path: "settings",
        element: <SettingsPage />,
      },
      {
        path: "w/:workspaceId",
        element: <WorkspaceLayout />,
        errorElement: <RouterErrorScreen />,
        children: [
          {
            path: "overview",
            element: <WorkspaceOverviewPage />,
          },
          {
            path: "runs",
            element: <WorkspaceRunsPage />,
          },
          {
            path: "runs/:runId",
            element: <WorkspaceRunDetailPage />,
          },
          {
            path: "settings",
            element: <WorkspaceSettingsPage />,
          },
          {
            path: "workflows",
            element: <WorkflowsPage />,
          },
          {
            path: "workflows/new",
            element: <NewWorkflowPage />,
          },
          {
            path: "workflows/:workflowId",
            element: <WorkflowDetailPage />,
          },
        ],
      },
    ],
  },
])
