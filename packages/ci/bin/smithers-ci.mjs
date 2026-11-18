#!/usr/bin/env node
// The `smithers-ci` executable. In a checkout it runs the VibeLang source
// through vibelang/register; a published install runs the built JavaScript.
// It runs in the repository that holds the working directory, and stops for
// SIGINT and SIGTERM: its steps end and its temporary copies are removed.
import { existsSync } from "node:fs"

const checkout = existsSync(new URL("../../../pnpm-workspace.yaml", import.meta.url))
if (checkout) await import("vibelang/register")
const at = (file) => new URL(checkout ? `../src/cli/${file}` : `../dist/esm/cli/${file}`, import.meta.url).href
const { main } = await import(at(checkout ? "main.vibe" : "main.js"))
const { listenTo } = await import(at(checkout ? "Signals.ts" : "Signals.js"))
process.exitCode = await main(process.argv.slice(2), process.cwd(), process.env, listenTo(process))
