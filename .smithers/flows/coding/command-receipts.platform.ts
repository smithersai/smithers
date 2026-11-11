// The platform code of command-receipts.vibe: Node's hashing, random identifiers and path joining.
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"

/**
 * The receipt file of `runId` under `directory`: the run's SHA-256 hex digest, so a run id never names a path.
 * @throws {never}
 */
export function receiptFile(directory: string, runId: string): string {
  return join(directory, createHash("sha256").update(runId).digest("hex") + ".json")
}

/**
 * A fresh random identifier (UUID v4) for an operation or a temporary file.
 * @throws {never}
 */
export function freshId(): string {
  return randomUUID()
}
