import path from "node:path"

import { DEFAULT_WORKSPACES_ROOT } from "@/config/paths"

export function resolveTestWorkspacePath(workspaceId: string) {
  return path.join(DEFAULT_WORKSPACES_ROOT, workspaceId)
}
