import { describe, test } from "vitest"
import { decodeJwtClaims, detectHarnessesWith, parseVersionLine, sanitizeDisplayText } from "../src/index.ts"
import type { HarnessHost } from "../src/index.ts"

const sampleJwt = `eyJhbGciOiJSUzI1NiJ9.${
  Buffer.from(JSON.stringify({ email: "dev@smithers.sh", sub: "user-1234", exp: 1999999999 })).toString("base64url")
}.signature`

const fakeHost: HarnessHost = {
  env: {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    OPENAI_API_KEY: "sk-openai-test-key"
  },
  home: "/Users/bench",
  platform: "darwin",
  listDir: () => [],
  isFile: (path) =>
    path === "/opt/homebrew/bin/claude" ||
    path === "/opt/homebrew/bin/codex" ||
    path === "/usr/local/bin/gemini",
  readText: (path) => {
    if (path.endsWith("auth.json")) {
      return JSON.stringify({ tokens: { id_token: sampleJwt } })
    }
    return null
  },
  version: async (binary) => `${binary} 2.14.3 (commit abc1234)`
}

const noisyVersionLines = [
  "\u001b[32mclaude\u001b[0m v2.14.3-beta.1 (darwin-arm64)\nsecond line ignored",
  "codex-cli 0.42.0\n",
  "\u001b[1;34mgemini\u001b[0m version 1.8.2+build.99"
]

describe("harness-detect hot paths", () => {
  test("detectHarnessesWith full table", async ({ bench }) => {
    await bench("detect all harnesses against host fixture", async () => {
      await detectHarnessesWith(fakeHost)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("parseVersionLine and sanitizeDisplayText", async ({ bench }) => {
    await bench("parse ANSI version lines + sanitize display text", () => {
      for (const line of noisyVersionLines) {
        const parsed = parseVersionLine(line)
        if (parsed !== null) sanitizeDisplayText(parsed)
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("decodeJwtClaims", async ({ bench }) => {
    await bench("decode JWT payload claims", () => {
      decodeJwtClaims(sampleJwt)
    }).run({ time: 120, warmupTime: 30 })
  })
})
