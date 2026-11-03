#!/usr/bin/env node
/** Generate and verify the target index on an installed test host, then return only its projection. */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
const cloud = process.argv[2] === "--cloud"
const commands = cloud
  ? [["bash", [".github/scripts/ci/cloud.sh", "target-index"]]]
  : [["pnpm", ["exec", "smthrs", "target", "//:targetIndex", "--write"]], ["pnpm", ["exec", "smthrs", "lint", "//:targetIndex"]]]
for (const [command, args] of commands) {
  const stage = cloud ? "generate-check" : args.includes("--write") ? "generate" : "check"
  const started = Date.now()
  console.error(`TARGET_INDEX stage=${stage} status=started`)
  // The Cloud gate installs pinned Node/pnpm and performs both commands once.
  // An inherited CI must not turn its generation half into check-only mode.
  const result = spawnSync(command, args, {
    stdio: cloud ? ["ignore", 2, 2] : ["ignore", "pipe", "pipe"],
    env: cloud ? { ...process.env, CI: "" } : process.env,
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024
  })
  if (result.status !== 0 || result.error) {
    process.stderr.write(result.stderr ?? "")
    process.stderr.write(result.stdout ?? "")
    throw new Error(`Target index generation/check failed (${result.status}): ${result.error?.message ?? args.join(" ")}`)
  }
  console.error(`TARGET_INDEX stage=${stage} status=done elapsed_ms=${Date.now() - started}`)
}
console.log(`SMITHERS_TARGET_INDEX ${readFileSync(".smithers/target-index.json").toString("base64")}`)
