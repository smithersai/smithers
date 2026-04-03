import { useMutation, useQueryClient } from "@tanstack/react-query"

import { burnsClient } from "@/lib/api/client"

export function useSaveWorkflow(workspaceId?: string, workflowId?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      source,
      filePath,
    }: {
      source: string
      filePath: string
    }) => burnsClient.saveWorkflowFile(workspaceId!, workflowId!, filePath, source),
    onSuccess: async (_data, variables) => {
      const isPrimaryWorkflowFile =
        variables.filePath === "workflow.tsx" || variables.filePath === "workflow.ts"

      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["workflow-file", workspaceId, workflowId, variables.filePath],
        }),
        ...(isPrimaryWorkflowFile
          ? [
              queryClient.invalidateQueries({ queryKey: ["workflows", workspaceId] }),
              queryClient.invalidateQueries({ queryKey: ["workflow", workspaceId, workflowId] }),
            ]
          : []),
      ])
    },
  })
}
