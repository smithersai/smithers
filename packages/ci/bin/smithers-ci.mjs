#!/usr/bin/env node
// The `smithers-ci` executable. In a checkout it runs the VibeLang source
// through vibelang/register; a published install runs the built JavaScript.
import { existsSync } from "node:fs"

const checkout = existsSync(new URL("../../../pnpm-workspace.yaml", import.meta.url))
if (checkout) await import("vibelang/register")
const entry = new URL(checkout ? "../src/cli/main.vibe" : "../dist/esm/cli/main.js", import.meta.url)
const { main } = await import(entry.href)
process.exitCode = await main(process.argv.slice(2), process.cwd())
