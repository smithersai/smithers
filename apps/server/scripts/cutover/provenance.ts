import { createHash } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ExportTarget } from "./targets"

export interface ReproducedSourceProof {
  readonly receipt: { readonly worker: string; readonly source: string; readonly dryRun: boolean; readonly gitSha: string; readonly timestamp: string; readonly wranglerVersionId: string }
  readonly modules: ReadonlyArray<{ readonly name: string; readonly file: string; readonly sha256: string }>
}
/** The identity deploy predates source annotations. Its official receipt alone is insufficient. */
export const verifyReproducedSource = (selected: ExportTarget, version: string, modules: ReadonlyArray<{ name: string; sha256: string }>, proof: ReproducedSourceProof, directory: string): string => {
  const receipt = proof.receipt
  if (selected.kind !== "identity" || receipt.worker !== selected.name || receipt.source !== "workers/identity" || receipt.dryRun !== false || receipt.wranglerVersionId !== version || !/^[a-f0-9]{40}$/.test(receipt.gitSha) || !Number.isFinite(Date.parse(receipt.timestamp))) throw new Error("Source receipt does not bind the live identity deployment")
  if (!Array.isArray(proof.modules) || proof.modules.length !== modules.length || new Set(proof.modules.map(module => module.name)).size !== modules.length) throw new Error("Reproduced module set differs")
  for (const actual of modules) {
    const built = proof.modules.find(module => module.name === actual.name)
    if (!built || !/^[a-zA-Z0-9_.-]+$/.test(built.file) || built.sha256 !== actual.sha256) throw new Error("Reproduced module differs from live bytes")
    const path = resolve(directory, built.file), stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 16_000_000) throw new Error("Reproduced module must be an owner-only regular file")
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== actual.sha256) throw new Error("Reproduced module file differs from live bytes")
  }
  return receipt.gitSha
}
