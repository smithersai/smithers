import path from "node:path"

function resolveWorkspaceRoot() {
  return path.resolve(import.meta.dir, "../../..")
}

export function resolveDaemonLifecyclePath() {
  return path.join(resolveWorkspaceRoot(), "apps/daemon/src/bootstrap/daemon-lifecycle.ts")
}
