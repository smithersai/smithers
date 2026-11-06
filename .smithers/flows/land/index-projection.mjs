#!/usr/bin/env node
/** Verify the target index and drift-sensitive release projections before returning the landing receipt. */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
const cloud = process.argv[2] === "--cloud"
// Keep Cloud checks in the shell that installed the certified Node and pnpm.
// Its PATH does not propagate back into this bootstrap process.
const commands = cloud
  ? [["bash", ["-e", "-o", "pipefail", "-c", [
    "source .github/scripts/ci/cloud.sh",
    "bootstrap_for target-index",
    "run_gate_checked target-index",
    'test "$gate_status" -eq 0',
    "node apps/site/scripts/sync-api-docs.mjs --check",
    "node .smithers/flows/release/check-api-baseline.mjs --build-declarations"
  ].join("\n")]]]
  : [
    ["pnpm", ["exec", "smthrs", "target", "//:targetIndex", "--write"]],
    ["pnpm", ["exec", "smthrs", "lint", "//:targetIndex"]],
    // Avoid packing every tarball and starting the durable docs flow under the
    // landing lease. The full docs gate remains in CI. These checks never write
    // API pages or accept declarations by updating their reviewed baseline.
    [process.execPath, ["apps/site/scripts/sync-api-docs.mjs", "--check"]],
    [process.execPath, [".smithers/flows/release/check-api-baseline.mjs", "--build-declarations"]]
  ]
for (const [command, args] of commands) {
  const stage = args[0].includes("sync-api-docs") ? "api-docs"
    : args[0].includes("check-api-baseline") ? "declarations"
    : cloud ? "generate-check-projections" : args.includes("--write") ? "generate" : "check"
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
    throw new Error(`Landing projection ${stage} failed (${result.status}): ${result.error?.message ?? args.join(" ")}`)
  }
  console.error(`TARGET_INDEX stage=${stage} status=done elapsed_ms=${Date.now() - started}`)
}
console.log(`SMITHERS_TARGET_INDEX ${readFileSync(".smithers/target-index.json").toString("base64")}`)
