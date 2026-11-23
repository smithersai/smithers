import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { describe, test } from "vitest"
import * as GitProxy from "../src/GitProxy.ts"
import * as bounded from "../src/internal/bounded.ts"
import * as scopedGit from "../src/internal/scopedGit.ts"

const sampleUrls = [
  ["GET", "http://forge.smithers.internal/org/repo/info/refs?service=git-upload-pack"],
  ["POST", "http://forge.smithers.internal/org/repo/git-upload-pack"],
  ["GET", "http://forge.smithers.internal/org/repo/info/refs?service=git-receive-pack"],
  ["POST", "http://forge.smithers.internal/org/repo/git-receive-pack"]
] as const

const tipSha = "0123456789abcdef0123456789abcdef01234567"
const encoder = new TextEncoder()
const negotiationPayload = encoder.encode(
  `${scopedGit.packet(`want ${tipSha} multi_ack_detailed side-band-64k\n`)}0000${scopedGit.packet("done\n")}`
)

const streamChunks: ReadonlyArray<Uint8Array> = Array.from(
  { length: 32 },
  (_, i) => new Uint8Array(1024).fill(i & 0xff)
)

describe("effect-code-storage hot paths", () => {
  test("GitProxy.classify", async ({ bench }) => {
    await bench("classify 4 git smart-HTTP proxy requests", () => {
      for (const [method, url] of sampleUrls) {
        GitProxy.classify(method, url)
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("scopedGit pkt-line framing and negotiation check", async ({ bench }) => {
    await bench("validate branch + frame pkt-line + inspect upload-pack negotiation", () => {
      scopedGit.validBranch("feat/incremental-bench-targets")
      scopedGit.packet(`want ${tipSha}\n`)
      scopedGit.negotiation(negotiationPayload, tipSha)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("bounded.readAtMost over 32 KiB stream", async ({ bench }) => {
    const program = bounded.readAtMost(Stream.fromIterable(streamChunks), 64 * 1024)
    await bench("read 32 x 1 KiB chunks under byte cap", async () => {
      await Effect.runPromise(program)
    }).run({ time: 120, warmupTime: 30 })
  })
})
