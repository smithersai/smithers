import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import { Effect, Layer } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Hex from "effect/encoding/Hex"
import { createHash, randomBytes } from "node:crypto"

const [operation, filename] = process.argv.slice(2)
if (filename === undefined) throw new Error("A database filename is required")
const crypto = Layer.succeed(EffectDigest.Digest)(EffectDigest.Digest.of({
  digest: (algorithm, data) => Effect.succeed(createHash(algorithm.name.replaceAll("-", "")).update(data).digest()),
  digestHex(algorithm, data) {
    return Effect.map(this.digest(algorithm, data), Hex.encode)
  }
})).pipe(Layer.merge(SecureRandom.layerWebCrypto))
const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
const memory = MemoryStore.layer.pipe(Layer.provide([database, crypto]))
const namespace = { kind: "global", id: "release" } as const

const result = await Effect.runPromise(
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    if (operation === "write") {
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: "restore the primary",
        provenance: { runId: "first-process" }
      })
      yield* store.enableFts("global")
      yield* store.putNote({ namespace, id: "release-note", text: "release checklist", tags: [], provenance: {} })
      yield* store.createThread({ namespace, id: "release-thread", title: "Release" })
      yield* store.appendMessage({
        threadId: "release-thread",
        id: "first",
        role: "user",
        text: "keep the checklist",
        at: 1
      })
    }
    return {
      fact: yield* store.getFact({ namespace, key: "runbook" }),
      notes: yield* store.listNotes({ namespace }),
      messages: yield* store.listMessages({ threadId: "release-thread" }),
      matches: (yield* store.searchFts({ namespace, query: "restore", limit: 10 })).map((row) => row.key)
    }
  }).pipe(Effect.provide(memory))
)
process.stdout.write(JSON.stringify(result))
