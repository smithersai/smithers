#!/usr/bin/env node
/**
 * Public process entry; bootstrap shared declaration identities before loading commands.
 * @since 1.0.0
 */

import * as NodeVersion from "./internal/NodeVersion.ts"

const bootstrap = async (): Promise<void> => {
  // Register source hooks before linking the command graph. A built entry only
  // imports JavaScript and does not need the compiler toolchain at runtime.
  const unsupported = NodeVersion.refusal(process.versions.node, process.execPath)
  if (unsupported !== undefined) {
    process.stderr.write(`${unsupported}\n`)
    process.exitCode = 1
  } else {
    if (import.meta.url.endsWith(".ts")) await import(import.meta.resolve("vibelang/register"))
    const Audience = await import("@smthrs/build-cli/Audience")
    const Redaction = await import("@smthrs/journal/Redaction")
    const Argv = await import("./cli/Argv.ts")
    const { agentArguments, formattedLogArguments, legacyArguments } = await import("./cli/Compatibility.ts")
    const { deferTypeScript } = await import("./internal/Bootstrap.ts")
    const Failure = await import("./internal/Failure.ts")

    const start = async (): Promise<void> => {
      // The hook module itself imports registerHooks. Load it only after the
      // version check, so older Node releases get the actionable refusal too.
      const { installEffectResolution } = await import("@smthrs/build-cli/effect-resolution")
      const original = process.argv.slice(2)
      // What a project flow imports besides Effect and the flow core. Owning them
      // lets a CLI installed outside the project host a flow built on a pattern.
      installEffectResolution({
        "@smthrs/agent": import.meta.url,
        "@smthrs/integrations": import.meta.url,
        "@smthrs/patterns": import.meta.url,
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
  }
}

await bootstrap()
