// The platform code of wiki-policy.vibe: where a policy source lives on disk beside this module in source mode.
import { fileURLToPath } from "node:url"

/**
 * The file the repository-relative policy `source` resolves to, read beside this module (three directories up).
 * @throws {never}
 */
export function policySourcePath(source: string): string {
  return fileURLToPath(new URL(`../../../${source}`, import.meta.url))
}
