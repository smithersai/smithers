// Stands where smthrs stands in smthrs-with-token.mjs and says what it was given: the token it reads by name,
// whether the system shows it in what the process was started with, whether a program it starts inherits it,
// whether it is still there once removed, and its arguments.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const name = "SMITHERS_CACHE_TOKEN"
const token = process.env[name]
const started = process.platform === "linux"
  ? readFileSync("/proc/self/environ", "utf8") + readFileSync("/proc/self/cmdline", "utf8")
  : execFileSync("ps", ["eww", "-p", String(process.pid)], { encoding: "utf8" })
const child = execFileSync(process.execPath, ["-e", `process.stdout.write(String(process.env.${name}))`], {
  encoding: "utf8"
})
const listed = Object.keys(process.env).includes(name)
// Smithers build changes variables it was started with, as it does `PATH`, and sets new ones.
process.env.PATH = `${process.env.PATH}:/nowhere`
process.env.SMITHERS_CI_TEST_SET = "set"
const sets = process.env.PATH.endsWith(":/nowhere") && process.env.SMITHERS_CI_TEST_SET === "set"
delete process.env[name]
console.log(JSON.stringify({
  token,
  shown: token !== undefined && started.includes(token),
  inherited: child !== "undefined" || listed,
  removed: process.env[name] === undefined && !(name in process.env),
  sets,
  argv: process.argv.slice(1)
}))
