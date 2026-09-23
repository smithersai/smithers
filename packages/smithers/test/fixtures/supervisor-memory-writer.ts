/**
 * One process writing `count` notes into a supervisor memory database, through
 * the layer the native host composes. `SupervisorMemory.test.ts` runs two of
 * these at once against one file.
 *
 *   node supervisor-memory-writer.ts <file> <label> <count>
 */
import { installEffectResolution } from "@smthrs/build-cli/effect-resolution"

installEffectResolution()
const [{ Effect }, MemoryStore, SupervisorMemory, { platform }] = await Promise.all([
  import("effect"),
  import("@smthrs/memory/MemoryStore"),
  import("../../src/internal/SupervisorMemory.ts"),
  import("../../src/internal/NodeControlHost.ts")
])
const [file, label, count] = process.argv.slice(2)
if (file === undefined || label === undefined || count === undefined) throw new Error("usage: <file> <label> <count>")

await Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  // Concurrently within the process as well, so the two connections contend.
  yield* Effect.forEach(
    Array.from({ length: Number(count) }, (_, index) => `${label}-${index}`),
    (id) =>
      store.putNote({
        namespace: { kind: "agent", id: "shared" },
        id,
        text: `note ${id}`,
        tags: ["source:supervisor"],
        provenance: { runId: label },
        status: "accepted"
      }),
    { concurrency: 16, discard: true }
  )
}).pipe(
  Effect.provide(
    SupervisorMemory.layer({
      environment: { SMITHERS_MEMORY_DB: file },
      database: platform.database,
      crypto: platform.crypto
    })
  ),
  Effect.scoped,
  Effect.runPromise
)
