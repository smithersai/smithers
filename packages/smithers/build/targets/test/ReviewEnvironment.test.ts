import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import { spawnEnvironment } from "../src/internal/ReviewEnvironment.ts"

describe("isolated review environment policy", () => {
  const host = {
    PATH: "tools",
    SystemRoot: "system",
    ANTHROPIC_API_KEY: "anthropic-fixture",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-fixture",
    OPENAI_API_KEY: "openai-fixture",
    CODEX_API_KEY: "codex-fixture",
    NODE_OPTIONS: "host-injection",
    SMITHERS_CACHE_TOKEN: "cache-fixture"
  }
  it("selects only Claude auth and withholds names marked sensitive", () => {
    const env = spawnEnvironment(["CLAUDE_CODE_OAUTH_TOKEN"], false, "/isolated", "claude", host, "linux", Path.join)
    expect(env).toEqual({
      PATH: "tools",
      HOME: "/isolated",
      TMPDIR: "/isolated",
      CLICOLOR: "0",
      FORCE_COLOR: "0",
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      ANTHROPIC_API_KEY: "anthropic-fixture",
      CLAUDE_CONFIG_DIR: Path.join("/isolated", ".claude")
    })
  })
  it("isolates Codex and Windows Git without carrying caller configuration", () => {
    const env = spawnEnvironment(["OPENAI_API_KEY"], true, "/isolated", "codex", host, "win32", Path.join)
    expect(env).toEqual({
      PATH: "tools",
      HOME: "/isolated",
      TMPDIR: "/isolated",
      USERPROFILE: "/isolated",
      SystemRoot: "system",
      CLICOLOR: "0",
      FORCE_COLOR: "0",
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      CODEX_API_KEY: "codex-fixture",
      CODEX_HOME: Path.join("/isolated", ".codex"),
      GIT_CONFIG_GLOBAL: "NUL",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0"
    })
  })
  it("handles absent host variables without inventing credentials", () => {
    const env = spawnEnvironment([], true, "/isolated", undefined, {}, "linux", Path.join)
    expect(env.PATH).toBe("")
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(spawnEnvironment([], false, "/isolated", "claude", {}, "win32", Path.join).SystemRoot).toBeUndefined()
    expect(spawnEnvironment([], false, "/isolated", "codex", {}, "linux", Path.join).CODEX_API_KEY).toBeUndefined()
  })
})
