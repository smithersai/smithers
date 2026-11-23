#!/usr/bin/env node

/**
 * Runs the smithers-build command-line process against the real process.
 *
 * @since 0.1.0
 */

import { main } from "./Entry.ts"
import { installEpipeHandler, terminalOf } from "./Reporter.ts"

const exitOnPipeClose = () => {
  process.exit(0)
}
installEpipeHandler(process.stdout, exitOnPipeClose)
installEpipeHandler(process.stderr, exitOnPipeClose)

await main({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: terminalOf(process.stdout),
  stderr: terminalOf(process.stderr),
  on: (signal, listener) => {
    process.on(signal, listener)
  },
  removeListener: (signal, listener) => {
    process.removeListener(signal, listener)
  },
  setExitCode: (code) => {
    process.exitCode = code
  }
})
