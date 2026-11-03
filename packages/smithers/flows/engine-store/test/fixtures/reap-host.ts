/** A stand-in Vitest worker: starts a tracked child, prints its pid, and ends without teardown. */
import * as ChildProcesses from "../ChildProcesses.ts"

const ending = process.argv[2]
const child = ChildProcesses.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
process.stdout.write(`${child.pid}\n`, () => {
  if (ending === "exit") process.exit(0)
})
setInterval(() => {}, 1000)
