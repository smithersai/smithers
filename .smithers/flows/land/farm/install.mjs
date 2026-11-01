#!/usr/bin/env node
/** Atomically install versioned farm clients beside existing state; never replace private host configuration. */
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const files = ["mini-run", "mini-remote.sh", "lat-run", "lat-remote.sh", "lat-services.sh", "health.sh", "compose.slot.yml"]
export function install(destination = join(homedir(), ".smithers-lead/scratchpad-mirror")) {
  mkdirSync(destination, { recursive: true })
  for (const name of files) {
    const temporary = join(destination, `.${name}.${process.pid}.new`)
    try {
      copyFileSync(join(import.meta.dirname, name), temporary)
      chmodSync(temporary, name.endsWith(".yml") ? 0o644 : 0o755)
      renameSync(temporary, join(destination, name))
    } finally { rmSync(temporary, { force: true }) }
  }
  console.log(`INSTALLED ${files.length} farm files in ${destination}; private config and active state preserved`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.length > 1 || args[0]?.startsWith("-")) { console.error("Usage: node .smithers/flows/land/farm/install.mjs [destination]"); process.exitCode = 2 }
  else install(args[0] === undefined ? undefined : resolve(args[0]))
}
