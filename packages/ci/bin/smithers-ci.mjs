#!/usr/bin/env node
// The `smithers-ci` executable. In a checkout it runs the VibeLang source
// through vibelang/register; a published install has no source and runs the
// built JavaScript. It runs in the repository that holds the working directory,
// and stops for SIGINT and SIGTERM: its steps end and its temporary copies are
// removed.
//
// A step of a replay can read what every process of this user was started with,
// so the program first starts again with a short environment. The variables it
// was started with come back in memory, for the parts that read a token.
//
// It always ends with one of its own exit codes and a line: `main` answers for
// the program once it runs, and what keeps it from running, such as an install
// with a file missing, is said here.
import { existsSync } from "node:fs"

const checkout = existsSync(new URL("../src/cli/main.vibe", import.meta.url))
const at = (file) => new URL(checkout ? `../src/cli/${file}` : `../dist/esm/cli/${file}`, import.meta.url).href
const run = async () => {
  const { own } = await import(at(checkout ? "Restart.ts" : "Restart.js"))
  const environment = await own(process)
  if (checkout) await import("vibelang/register")
  const { main } = await import(at(checkout ? "main.vibe" : "main.js"))
  const { listenTo } = await import(at(checkout ? "Signals.ts" : "Signals.js"))
  return await main(process.argv.slice(2), process.cwd(), environment, listenTo(process))
}
process.exitCode = await run().catch((cause) => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  process.stderr.write(`smithers-ci: could not run: ${reason.replace(/\s+/g, " ").trim()}\n`)
  return 4
})
