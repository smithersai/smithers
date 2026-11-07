// Platform values for process-boundary tests; Effect tests import these inert values.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
export const nodePath = process.execPath
export const serverPath = fileURLToPath(new URL("../dist-factory/surfaces/mcp-entry.js", import.meta.url))
export function cliManifest() {
  const entry = fileURLToPath(new URL("../dist-factory/surfaces/cli-entry.js", import.meta.url))
  const result = spawnSync(nodePath, [entry, "--llms"], { encoding: "utf8", timeout: 10_000 })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}
