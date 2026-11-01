/** Fetch a verified target-index projection without installing a source workspace. */
import { writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { jj } from "./numbering.mjs"
import { runProcess } from "./process.mjs"
import { indexPath } from "./generated.mjs"

export function decodeProjection(output) {
  const matches = [...output.matchAll(/^SMITHERS_TARGET_INDEX ([A-Za-z0-9+/=]+)$/gm)]
  if (matches.length !== 1) throw new Error("Expected exactly one verified target index receipt")
  const text = Buffer.from(matches[0][1], "base64").toString("utf8")
  const rows = JSON.parse(text)
  if (!Array.isArray(rows) || !rows.length || rows.some((row) => typeof row.label !== "string" || !row.label.startsWith("//")) || new Set(rows.map((row) => row.label)).size !== rows.length) {
    throw new Error("Invalid target index receipt")
  }
  return text
}

/** Only publish the projection if local source stayed unchanged throughout sync and generation. */
export async function regenerateIndex(root, runner = process.env.SMITHERS_MINI_RUN ?? join(homedir(), ".smithers-lead/scratchpad-mirror/mini-run"), signal) {
  const before = jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
  console.error("PREPARING target index on mini (bounded admission, no local install)")
  const result = await runProcess(runner, [".", "--", "node", ".smithers/flows/land/index-projection.mjs"], {
    cwd: root, env: { ...process.env, MINI_RUN_SRC: root }, signal, streamError: true, timeoutMs: 15 * 60 * 1000
  })
  if (result.status !== 0) throw new Error(`Remote target index failed: ${result.stderr || result.status}`)
  const source = decodeProjection(result.stdout)
  const after = jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
  if (before !== after) throw new Error("Source changed during remote generation; no target index was written")
  writeFileSync(join(root, indexPath), source)
  console.error("PREPARED target index (generated and checked on mini)")
}
