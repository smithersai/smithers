#!/usr/bin/env node
/** Generate and verify the target index on an installed test host, then return only its projection. */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
for (const args of [["exec", "smthrs", "target", "//:targetIndex", "--write"], ["exec", "smthrs", "lint", "//:targetIndex"]]) {
  const result = spawnSync("pnpm", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0 || result.error) {
    process.stderr.write(result.stderr ?? "")
    process.stderr.write(result.stdout ?? "")
    throw new Error(`Target index generation/check failed (${result.status}): ${result.error?.message ?? args.join(" ")}`)
  }
}
console.log(`SMITHERS_TARGET_INDEX ${readFileSync(".smithers/target-index.json").toString("base64")}`)
