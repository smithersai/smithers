import { digestSync } from "@smthrs/crypto"
import type { SandboxBranch } from "../branch/Sandboxes.ts"
import type { ChecksRequest } from "./Checks.vibe"

export const jobMachineOf = (request: ChecksRequest): { readonly branch: SandboxBranch; readonly ownerId: string } => {
  const [owner = "", name = ""] = request.repoId.replace(/^github\//, "").split("/")
  // Named by a digest of the repository and the SHA together, so no two repositories' jobs share a machine, however
  // their names split (`acme/tools-ui` and `acme-tools/ui`).
  const job = digestSync(JSON.stringify([request.repoId, request.sha])).slice(0, 40)
  return {
    branch: { branchId: `job-${job}`, owner, name, branch: request.branch, forge: "github", kind: "job" },
    ownerId: request.ownerId,
  }
}
