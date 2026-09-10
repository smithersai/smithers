/** Fingerprint the running reviewer recipe, independently of target-repo copies. */
import * as Digest from "@smthrs/core/Digest"
import { Effect, FileSystem, Stream } from "effect"
import { fileURLToPath } from "node:url"

// The existing deployment bundler injects a digest of its exact executable
// bytes before this declaration is inserted. Source mode has no such binding.
declare const __SMITHERS_CODING_ARTIFACT_DIGEST__: string | undefined

// Actual owning policy, including task/output/evidence, assessment, reuse and
// authority configuration. These paths resolve from THIS module, never from
// the repository an agent is changing. Dependency pins also invalidate reuse.
const sources = [
  "../wiki/workflow.ts", "../wiki/schema.ts", "../wiki/evidence.ts", "../wiki/runtime.ts",
  "../wiki/operations.ts", "../wiki/reuse.ts", "./host.ts", "./planning-wiki.ts",
  "./planning-authority.ts", "./wiki-policy.ts", "../../pnpm-lock.yaml",
  "../../packages/smithers/agent/src/AgentAction.ts"
] as const

export const runningWikiPolicy = Effect.gen(function*() {
  if (typeof __SMITHERS_CODING_ARTIFACT_DIGEST__ !== "undefined") {
    if (!/^[a-f0-9]{64}$/.test(__SMITHERS_CODING_ARTIFACT_DIGEST__)) {
      return yield* Effect.fail(new Error("Invalid coding host artifact fingerprint"))
    }
    return `artifact:${__SMITHERS_CODING_ARTIFACT_DIGEST__}`
  }
  const fs = yield* FileSystem.FileSystem
  const captured = yield* Effect.forEach(sources, source => Effect.gen(function*() {
    const data = yield* Stream.runFoldEffect(fs.stream(fileURLToPath(new URL(source, import.meta.url)), {
      bytesToRead: 2 * 1024 * 1024 + 1, chunkSize: 64 * 1024
    }), () => ({ chunks: [] as Uint8Array[], bytes: 0 }), (state, chunk) => {
      if (state.bytes + chunk.length > 2 * 1024 * 1024) return Effect.fail(new Error("Coding reviewer policy source exceeds 2 MiB"))
      state.chunks.push(chunk)
      state.bytes += chunk.length
      return Effect.succeed(state)
    })
    const bytes = new Uint8Array(data.bytes)
    let offset = 0
    for (const chunk of data.chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return { source, digest: Digest.digest(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  }))
  return `source:${Digest.digest(Digest.canonical(captured))}`
})
