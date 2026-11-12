import { NodeHost } from "@smthrs/platform-node"
import { spawnSync } from "node:child_process"
import type { TestProject } from "vitest/node"

interface TerminalTools {
  readonly renderer: string
  readonly probe: string
  readonly env: Readonly<Record<string, string>>
}

declare module "vitest" {
  export interface ProvidedContext {
    terminalTools: TerminalTools
  }
}

/** Real integration dependencies: no worker silently substitutes a fake renderer or publisher. */
export default function setup(project: TestProject): () => void {
  // Pin the real native service for workers and CLI children alike. Resolve
  // before starting tests so missing tools do not masquerade as refusal paths.
  const previous = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
  process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY = NodeHost.AtomicFileSystem.resolveHelper()
  const renderer = process.env.SMITHERS_TEST_FFMPEG ?? "ffmpeg"
  const probe = process.env.SMITHERS_TEST_FFPROBE ?? "ffprobe"
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" }
  if (process.env.FONTCONFIG_FILE !== undefined) env.FONTCONFIG_FILE = process.env.FONTCONFIG_FILE
  for (const executable of [renderer, probe]) {
    const result = spawnSync(executable, ["-version"], { encoding: "utf8", env, timeout: 10_000 })
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `@smthrs/testing needs FFmpeg 7+ and ffprobe with drawtext/fontconfig and a monospace font; cannot run ${executable}. See README.md#integration-test-tools`,
        { cause: result.error }
      )
    }
    console.info(`[testing-host-tools] ${result.stdout.split("\n")[0]}`)
  }
  project.provide("terminalTools", { renderer, probe, env })
  return () => {
    if (previous === undefined) delete process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
    else process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY = previous
  }
}
