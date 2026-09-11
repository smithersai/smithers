import { isAbsolute } from "node:path"

/** Host checkouts are never discovered from HOME or directory presence in a unit run. */
export const hostWorkspaceTests = (env: Readonly<Record<string, string | undefined>>) => {
  if (env.SMITHERS_HOST_WORKSPACE_TESTS !== "1") return { read: undefined, run: undefined }
  const read = env.SMITHERS_GRAPH_READ_WORKSPACE
  const run = env.SMITHERS_GRAPH_RUN_WORKSPACE
  if (read === undefined && run === undefined) {
    throw new Error(
      "Host-workspace tests need an explicit SMITHERS_GRAPH_READ_WORKSPACE or SMITHERS_GRAPH_RUN_WORKSPACE path."
    )
  }
  for (const path of [read, run]) {
    if (path !== undefined && !isAbsolute(path)) throw new Error("Host-workspace test paths must be absolute.")
  }
  return { read, run }
}
