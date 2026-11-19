// `smithers-ci` as a process whose work stops before it has an exit code of its own, for Stopped.test.ts.
// Usage: stopped.mjs <how> <marker or name> [smithers-ci arguments]. Same program, same host as the bin.
import { fileURLToPath } from "node:url"

process.env.VIBELANG_PROJECT = new URL("../../tsconfig.test.json", import.meta.url).pathname
await import("vibelang/register")
const { run } = await import("../../src/cli/main.vibe")
const { listenTo } = await import("../../src/cli/Signals.ts")
const { readingSilently, replayingWith, stoppingParts } = await import("./stopped.vibe")
const [how, given, ...args] = process.argv.slice(2)
// Smithers build behind the script that leaves what a build in a jail leaves.
const leaving = [
  "/bin/sh",
  fileURLToPath(new URL("./smthrs-left.sh", import.meta.url)),
  process.execPath,
  fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))
]
const parts = how === "reads"
  ? readingSilently(given)
  : how === "leaves"
  ? replayingWith(leaving, process.env)
  : stoppingParts(given, how)
process.exitCode = await run(args, process.cwd(), process.env, parts, listenTo(process))
