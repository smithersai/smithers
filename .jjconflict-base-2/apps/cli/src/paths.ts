import path from "node:path"

function resolveWorkspaceRoot() {
  return path.resolve(import.meta.dir, "../../..")
}

export function resolveDaemonEntrypointPath() {
  return path.join(resolveWorkspaceRoot(), "apps/daemon/src/main.ts")
}

export function resolveDaemonLifecyclePath() {
  return path.join(resolveWorkspaceRoot(), "apps/daemon/src/bootstrap/daemon-lifecycle.ts")
}

export function resolveWebDistPath() {
  return path.join(resolveWorkspaceRoot(), "dist/web")
}
