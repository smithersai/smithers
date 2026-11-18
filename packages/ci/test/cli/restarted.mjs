// What a new start of the program sees: what `own` gives it, what its process holds afterwards, and what the
// system says the process was started with. Printed as JSON for Restart.test.ts.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { own } from "../../src/cli/Restart.ts"

const given = await own(process)
const startedWith = process.platform === "linux"
  ? readFileSync("/proc/self/environ", "utf8")
  : execFileSync("ps", ["eww", "-p", String(process.pid)], { encoding: "utf8" })
console.log(JSON.stringify({ args: process.argv.slice(2), given, holds: Object.keys(process.env), startedWith }))
