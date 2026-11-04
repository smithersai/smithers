/** Fetch a verified target-index projection without installing a source workspace. */
import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { writeSource } from "./files.mjs"
import { jj } from "./numbering.mjs"
import { runProcess } from "./process.mjs"
import { indexPath } from "./generated.mjs"
import { cfboxClient, runCfbox, withTrackedTree } from "./cfbox.mjs"

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
export async function regenerateIndex(root, runner = process.env.SMITHERS_MINI_RUN ?? join(homedir(), ".smithers-lead/scratchpad-mirror/mini-run"), signal, box = cfboxClient()) {
  const before = jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
  console.error("PREPARING target index on mini (5 s admission, no local install)")
  let host = "mini"
  let result = await runProcess(runner, [".", "--", "node", ".smithers/flows/land/index-projection.mjs"], {
    cwd: root, env: { ...process.env, MINI_RUN_SRC: root, MINI_RUN_WAIT_SECONDS: "5" }, signal, streamError: true, timeoutMs: 15 * 60 * 1000
  })
  const output = result.stdout + "\n" + result.stderr
  const diskFull = result.status === 73 || /\bFARM_HEALTH\s+DISK_FULL\b/.test(output)
  if (result.status !== 0 && (diskFull || result.status === 7 || /\bCAPACITY_TIMEOUT\b/.test(output))) {
    host = "cfbox"
    console.error(`TARGET_INDEX host=mini status=${diskFull ? "disk_full" : "capacity_timeout"} exit=${result.status}; falling back to cfbox`)
    result = await withTrackedTree(root, "smithers-index-", async (tree) => {
      const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim()
      return runCfbox(root, tree, ["node", ".smithers/flows/land/index-projection.mjs", "--cloud"], {
        box, signal, cacheKey: `target-index-node-${nodeVersion}`
      })
    })
  }
  if (result.status !== 0) throw new Error(`Remote target index failed on ${host} (exit ${result.status}): ${result.stderr || result.status}`)
  const source = decodeProjection(result.stdout)
  const after = jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
  if (before !== after) throw new Error("Source changed during remote generation; no target index was written")
  writeSource(root, indexPath, source)
  console.error(`PREPARED target index (generated and checked on ${host})`)
}
