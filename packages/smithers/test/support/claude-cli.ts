/**
 * The real Claude Code CLI, as `PATH` entries.
 *
 * Smithers depends on `@anthropic-ai/claude-agent-sdk`, which installs the
 * Claude Code executable for this platform. Tests register through that writer
 * rather than a stand-in, so they exercise Claude Code's own locking and merge.
 */
import { createRequire } from "node:module"
import { dirname } from "node:path"

const sdk = createRequire(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"))

const platformPackage = (): string => {
  for (const libc of ["", "-musl"]) {
    try {
      return dirname(
        sdk.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}/package.json`)
      )
    } catch {
      // Not installed for this libc; try the other.
    }
  }
  throw new Error(`The Agent SDK installed no Claude Code CLI for ${process.platform}-${process.arch}`)
}

/** This process's `PATH` with the installed `claude` first. */
export const claudePath = (): string => `${platformPackage()}:${process.env.PATH}`
