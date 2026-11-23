import * as Effect from "effect/Effect"
import { describe, test } from "vitest"
import { TerminalProtocol } from "../src/index.ts"
import { configurationFingerprint } from "../src/internal/configurationFingerprint.ts"
import { rootedAt } from "../src/internal/rootedPath.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import { validateNetworkPolicy } from "../src/Sandbox/NetworkPolicy.ts"
import { validateResourceLimits } from "../src/Sandbox/ResourceLimits.ts"

const sampleConfig = {
  image: "ghcr.io/smithersai/sandbox:latest",
  workdir: "/workspace/repo",
  network: { allow: ["api.github.com", "registry.npmjs.org", "*.cloudflare.com"] },
  limits: { cpus: 4, memoryMib: 2048, timeoutSecs: 600 },
  env: { NODE_ENV: "test", CI: "1", SMITHERS_LANE: "bench-lane" },
  args: ["--read-only", "--pids-limit=256"]
}

const sampleNetworkPolicy = {
  allow: ["api.github.com", "registry.npmjs.org", "*.npmjs.org", "objects.githubusercontent.com", "api.openai.com"]
} as const

const sampleLimits = { cpus: 4, memoryMib: 4096, timeoutSecs: 900 } as const
const rootPosix = rootedAt("/workspace/project/")
const encodedResize = TerminalProtocol.encodeResize(120, 40)
const encodedReady = TerminalProtocol.encodeServerControl({ type: "ready", access: "write" })

describe("@smthrs/sandbox", () => {
  test("validateNetworkPolicy + validateResourceLimits", async ({ bench }) => {
    await bench("policy + limits validation", () => {
      validateNetworkPolicy("bench", sampleNetworkPolicy)
      validateResourceLimits("bench", sampleLimits)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("sessionSlug + rootedAt path normalization", async ({ bench }) => {
    await bench("sessionSlug + rootedAt", () => {
      sessionSlug("org/repo/branch/feature-perf-12345/attempt-9")
      rootPosix("./src//nested/file.ts")
      rootPosix("/abs/path/outside.ts")
    }).run({ time: 120, warmupTime: 30 })
  })

  test("TerminalProtocol encode/decode control frames", async ({ bench }) => {
    await bench("TerminalProtocol roundtrip", () => {
      TerminalProtocol.decodeClientControl(TerminalProtocol.encodeResize(120, 40))
      TerminalProtocol.decodeClientControl(encodedResize)
      TerminalProtocol.decodeServerControl(encodedReady)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("configurationFingerprint (canonical SHA-256 hash)", async ({ bench }) => {
    await bench("configurationFingerprint", async () => {
      await Effect.runPromise(configurationFingerprint(sampleConfig))
    }).run({ time: 150, warmupTime: 30 })
  })
})
