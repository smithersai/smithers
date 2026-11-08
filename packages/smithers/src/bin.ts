#!/usr/bin/env node
/**
 * Public process entry; bootstrap shared declaration identities before loading commands.
 * @since 1.0.0
 */

import * as Audience from "@smthrs/build-cli/Audience"
import * as Redaction from "@smthrs/journal/Redaction"
import * as Argv from "./cli/Argv.ts"
import { agentArguments, formattedLogArguments, legacyArguments } from "./cli/Compatibility.ts"
import { deferTypeScript } from "./internal/Bootstrap.ts"
import * as Failure from "./internal/Failure.ts"
import * as NodeVersion from "./internal/NodeVersion.ts"

const start = async (): Promise<void> => {
  // Before any command loads: on an older Node a dependency fails at link time
  // and the failure report could only say that something went wrong.
  const unsupported = NodeVersion.refusal(process.versions.node, process.execPath)
  if (unsupported !== undefined) {
    process.stderr.write(`${unsupported}\n`)
    process.exitCode = 1
    return
  }
  // The hook module itself imports registerHooks. Load it only after the
  // version check, so older Node releases get the actionable refusal too.
  const { installEffectResolution } = await import("@smthrs/build-cli/effect-resolution")
  const original = process.argv.slice(2)
  installEffectResolution({
    "@smthrs/agent": import.meta.url,
    "@smthrs/registry/Prompt/jsx-runtime": import.meta.url
  }, { deferTypeScript: deferTypeScript(original) })
  const parsed = Argv.parse(original)
  let agentAlias = formattedLogArguments(parsed)
  try {
    agentAlias ??= Audience.fromArguments(original).audience === "agent" ? agentArguments(parsed) : undefined
  } catch { /* The selected entrypoint renders invalid presentation configuration. */ }
  const legacy = agentAlias === undefined ? legacyArguments(parsed) : undefined
  if (legacy !== undefined) {
    installEffectResolution()
    process.argv.splice(2, process.argv.length - 2, ...legacy)
    await import("./cli/LegacyBin.ts")
  } else {
    const { main } = await import("./cli/Entry.vibe")
    // Environment CRUD can bootstrap natively. Durable and protocol commands
    // retain tsx before importing SDK callbacks, whose source shapes persist.
    installEffectResolution()
    await main({
      argv: agentAlias ?? original,
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
      on: (signal, listener) => {
        process.on(signal, listener)
      },
      removeListener: (signal, listener) => {
        process.removeListener(signal, listener)
      },
      setExitCode: (code) => {
        process.exitCode = code
      },
      waitForDisconnect: (signal) =>
        new Promise<void>((resolve) => {
          const finish = () => {
            process.stdin.removeListener("end", finish)
            process.stdin.removeListener("close", finish)
            signal.removeEventListener("abort", abort)
            resolve()
          }
          const abort = () => {
            process.stdin.destroy()
            finish()
          }
          if (signal.aborted) abort()
          else if (process.stdin.readableEnded || process.stdin.destroyed) finish()
          else {
            process.stdin.once("end", finish)
            process.stdin.once("close", finish)
            signal.addEventListener("abort", abort, { once: true })
          }
        })
    })
  }
}

void start().catch((cause: unknown) => {
  const text = Failure.commandReport(cause, Argv.parse(process.argv.slice(2)).verbose)
  process.stderr.write(`${String(Redaction.redactDiagnostic(text))}\n`)
  process.exitCode = 1
})
