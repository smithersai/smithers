#!/usr/bin/env bun
/**
 * smithers-tui [--model provider:id] [directory]
 */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { App } from "./app.tsx"
import * as Host from "./host.ts"
import * as Models from "./models.ts"

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { model: { type: "string", short: "m" } },
  allowPositionals: true
})
const cwd = resolve(positionals[0] ?? process.cwd())
process.chdir(cwd)

const available = Models.detect(process.env)
const seat = values.model ?? available.defaultSeat
if (seat === undefined) {
  console.error("No model is available. Run `codex login` for the ChatGPT subscription, or set a provider API key.")
  process.exit(1)
}
const host = Host.make({ cwd, environment: available.environment })
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(<App host={host} seat={seat} models={available.models} />)
