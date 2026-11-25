#!/usr/bin/env node
import { existsSync } from "node:fs"

const checkout = existsSync(new URL("../src/Cli.ts", import.meta.url))
const entry = new URL(checkout ? "../src/Cli.ts" : "../dist/esm/Cli.js", import.meta.url).href

const run = async () => {
  if (checkout) await import("vibelang/register")
  const { runCliMain } = await import(entry)
  return await runCliMain(process.argv.slice(2), process.cwd())
}

process.exitCode = await run().catch((cause) => {
  const reason = cause instanceof Error ? cause.message : String(cause)
  process.stderr.write(`smithers-comments: fatal: ${reason.replace(/\s+/g, " ").trim()}\n`)
  return 4
})
