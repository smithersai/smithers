// Starts as `smthrs` starts, then says what this start can see. Used by Apart.test.ts.
//
// It prints one JSON document: how many processes it sees, whether a canary is in what any process it can read was
// started with, a digest of the token it reads by name, the names of its variables, what a program it starts inherits,
// and whether the system lets a program gain a privilege. It prints names and booleans, never a value it was given.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { receive, startApart, tokenName } from "../../bin/apart.mjs"

const ended = await startApart()
if (ended !== undefined) process.exit(ended)
receive()

// What it looks for is the token it reads by name: no command line holds it.
const canary = process.env[tokenName]
const numbered = readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name))
const startedWith = numbered.some((pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, "utf8").includes(canary) ||
      readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(canary)
  } catch {
    return false
  }
})
const child = spawnSync("sh", ["-c", `echo "\${${tokenName}-unset}"; echo "\${OTHER-unset}"`], { encoding: "utf8" })
const [inheritedToken, inheritedOther] = child.stdout.trim().split("\n")
const token = process.env[tokenName]
const held = tokenName in process.env
delete process.env[tokenName]
console.log(JSON.stringify({
  processes: numbered.length,
  startedWith,
  tokenDigest: createHash("sha256").update(token ?? "").digest("hex"),
  held,
  afterRemoval: process.env[tokenName] ?? null,
  names: Object.keys(process.env).sort(),
  otherIsSet: process.env.OTHER !== undefined,
  inheritsToken: inheritedToken !== "unset",
  inheritsOther: inheritedOther !== "unset",
  noNewPrivileges: /^NoNewPrivs:\s*1$/m.test(readFileSync("/proc/self/status", "utf8"))
}))
if (process.argv.includes("--exit-7")) process.exit(7)
if (process.argv.includes("--wait")) setInterval(() => {}, 1_000)
