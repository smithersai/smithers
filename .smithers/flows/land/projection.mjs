/** Fetch a verified target-index projection without installing a source workspace. */
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { sourcePath, writeSource } from "./files.mjs"
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
export async function regenerateIndex(root, runner = process.env.SMITHERS_MINI_RUN ?? join(homedir(), ".smithers-lead/scratchpad-mirror/mini-run"), signal, box = process.env.SMITHERS_CFBOX ?? join(homedir(), ".vibe-orch/bin/cfbox")) {
  const before = jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
  console.error("PREPARING target index on mini (no capacity wait, no local install)")
  let host = "mini"
  let result = await runProcess(runner, [".", "--", "node", ".smithers/flows/land/index-projection.mjs"], {
    cwd: root, env: { ...process.env, MINI_RUN_SRC: root, MINI_RUN_WAIT_SECONDS: "0" }, signal, streamError: true, timeoutMs: 15 * 60 * 1000
  })
  if (result.status !== 0 && (result.status === 7 || /\bCAPACITY_TIMEOUT\b/.test(result.stdout + "\n" + result.stderr))) {
    host = "cfbox"
    console.error(`TARGET_INDEX host=mini status=capacity_timeout exit=${result.status}; falling back to cfbox`)
    // cfbox normally discovers files with Git. Supply a jj-listed source-only
    // staging tree and --with-deps to select its directory walker, without any
    // VCS storage, ignored dependencies or credentials from the invoking home.
    const tree = mkdtempSync(join(tmpdir(), "smithers-index-"))
    try {
      for (const path of jj(root, ["file", "list"]).split("\n").filter(Boolean)) {
        const source = sourcePath(root, path, true)
        mkdirSync(dirname(join(tree, path)), { recursive: true })
        cpSync(source, join(tree, path), { dereference: false, verbatimSymlinks: true, preserveTimestamps: true })
      }
      const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim()
      const transport = process.env.SMITHERS_CFBOX_VIA ? ["--via", process.env.SMITHERS_CFBOX_VIA] : ["--cache", "--cache-key", `target-index-node-${nodeVersion}`]
      result = await runProcess(box, ["run", "--cpu", "2", "--with-deps", ...transport, tree, "--", "node", ".smithers/flows/land/index-projection.mjs", "--cloud"], {
        cwd: root, signal, streamError: true, timeoutMs: 15 * 60 * 1000
      })
    } finally { rmSync(tree, { recursive: true, force: true }) }
  }
  if (result.status !== 0) throw new Error(`Remote target index failed on ${host} (exit ${result.status}): ${result.stderr || result.status}`)
  const source = decodeProjection(result.stdout)
  const after = jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
  if (before !== after) throw new Error("Source changed during remote generation; no target index was written")
  writeSource(root, indexPath, source)
  console.error(`PREPARED target index (generated and checked on ${host})`)
}
