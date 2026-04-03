import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { describe, expect, it } from "bun:test"

import { resolveWorkspaceAnthropicApiKey } from "@/services/agent-cli-service"

function withTempWorkspace(run: (workspacePath: string) => void) {
  const workspacePath = mkdtempSync(path.join(tmpdir(), "burns-agent-cli-service-"))

  try {
    run(workspacePath)
  } finally {
    rmSync(workspacePath, { recursive: true, force: true })
  }
}

describe("resolveWorkspaceAnthropicApiKey", () => {
  it("returns undefined when workspace env files do not exist", () => {
    withTempWorkspace((workspacePath) => {
      expect(resolveWorkspaceAnthropicApiKey(workspacePath)).toBeUndefined()
    })
  })

  it("reads ANTHROPIC_API_KEY from .env", () => {
    withTempWorkspace((workspacePath) => {
      writeFileSync(path.join(workspacePath, ".env"), "ANTHROPIC_API_KEY=env-key\n", "utf8")

      expect(resolveWorkspaceAnthropicApiKey(workspacePath)).toBe("env-key")
    })
  })

  it("prefers .env.local over .env", () => {
    withTempWorkspace((workspacePath) => {
      writeFileSync(path.join(workspacePath, ".env"), "ANTHROPIC_API_KEY=env-key\n", "utf8")
      writeFileSync(path.join(workspacePath, ".env.local"), "ANTHROPIC_API_KEY=local-key\n", "utf8")

      expect(resolveWorkspaceAnthropicApiKey(workspacePath)).toBe("local-key")
    })
  })

  it("supports export syntax and quoted values", () => {
    withTempWorkspace((workspacePath) => {
      writeFileSync(
        path.join(workspacePath, ".env.local"),
        'export ANTHROPIC_API_KEY="quoted-key"\n',
        "utf8"
      )

      expect(resolveWorkspaceAnthropicApiKey(workspacePath)).toBe("quoted-key")
    })
  })

  it("treats empty values as missing", () => {
    withTempWorkspace((workspacePath) => {
      writeFileSync(path.join(workspacePath, ".env.local"), "ANTHROPIC_API_KEY=\n", "utf8")

      expect(resolveWorkspaceAnthropicApiKey(workspacePath)).toBeUndefined()
    })
  })
})
