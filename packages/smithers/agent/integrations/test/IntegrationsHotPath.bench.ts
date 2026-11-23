import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { beforeAll, describe, test } from "vitest"
import * as Redact from "../src/core/Redact.ts"
import * as Signature from "../src/core/Signature.ts"
import * as Payload from "../src/github/Payload.ts"

const webhookSecret = "whsec_bench_secret_value_0123456789abcdef"
const webhookBody = JSON.stringify({
  action: "opened",
  number: 4242,
  repository: {
    full_name: "smithersai/smithers",
    name: "smithers",
    owner: { login: "smithersai", id: 1, type: "Organization" },
    default_branch: "main"
  },
  pull_request: {
    number: 4242,
    title: "Wire incremental benchmarks across workspace",
    body: "Detailed PR description ".repeat(50),
    state: "open",
    draft: false,
    user: { login: "alice", id: 10, type: "User" },
    head: { ref: "perf/bench", sha: "0123456789abcdef0123456789abcdef01234567" },
    base: { ref: "main", sha: "fedcba9876543210fedcba9876543210fedcba98" }
  },
  sender: { login: "alice", id: 10, type: "User" }
})
const parsedWebhookBody = JSON.parse(webhookBody) as unknown
const decodePullRequestEvent = Schema.decodeUnknownSync(Payload.PullRequestEvent)

const secrets = [
  "ghp_secretTokenValue1234567890abcdef",
  "sk-ant-api03-secret-value-9876543210",
  "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"
]
const logPayload = Array.from(
  { length: 80 },
  (_, i) =>
    `[${i}] request auth=${secrets[i % secrets.length]} repo=smithersai/smithers status=200 duration_ms=${i * 3}`
).join("\n")

const digestA = new Uint8Array(32).fill(0xab)
const digestB = new Uint8Array(32).fill(0xab)

describe("integrations hot paths", () => {
  let validSignature = ""

  beforeAll(async () => {
    const hex = await Effect.runPromise(Signature.computeHmacSha256Hex(webhookBody, webhookSecret))
    validSignature = `${Signature.GITHUB_SIGNATURE_PREFIX}${hex}`
  })

  test("Signature.constantTimeEqual", async ({ bench }) => {
    await bench("compare 32-byte HMAC digests in constant time", () => {
      Signature.constantTimeEqual(digestA, digestB)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Signature.verifySignature", async ({ bench }) => {
    await bench("verify GitHub HMAC-SHA256 webhook signature", async () => {
      await Effect.runPromise(
        Signature.verifySignature({
          payload: webhookBody,
          secret: webhookSecret,
          signature: validSignature
        })
      )
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Redact.redact", async ({ bench }) => {
    await bench("redact 3 secrets across 80-line log payload", () => {
      Redact.redact(logPayload, secrets)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Payload.PullRequestEvent decode", async ({ bench }) => {
    await bench("decode GitHub pull_request webhook payload", () => {
      decodePullRequestEvent(parsedWebhookBody)
    }).run({ time: 120, warmupTime: 30 })
  })
})
