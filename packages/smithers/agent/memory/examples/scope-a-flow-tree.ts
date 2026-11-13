/**
 * Attach a memory policy to the `remember` and `recall` flows and call them
 * through the policy-enforcing handlers: writes name a policy bank, recall
 * defaults to the policy banks, and a foreign bank is refused before I/O.
 */
import { Effect, Layer, Schema } from "effect"
import * as Flows from "../src/Flows.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as RecallKeyword from "../src/RecallKeyword.ts"
import * as TestMemory from "../src/test/TestMemory.ts"
import * as WithMemory from "../src/WithMemory.ts"

const policy: WithMemory.Policy = { banks: ["flow-release-notes"], maxTokens: 2048 }

const memory = Layer.provideMerge(RecallKeyword.layer, TestMemory.layer)

/** Writes and recalls inside the policy, then tries a bank outside it. */
export const scopeAFlowTree = (): Promise<{
  readonly recalledKeys: ReadonlyArray<string>
  readonly provenance: unknown
  readonly foreignBank: string
}> =>
  Effect.gen(function*() {
    const remember = Flows.handlersFor(WithMemory.withMemory(Flows.remember, policy), {
      runId: "run-1",
      nodeId: "node-7",
      iteration: 0
    }).remember
    const recall = Flows.handlersFor(WithMemory.withMemory(Flows.recall, policy)).recall

    // Decode the same input a bound flow accepts: every write names its bank.
    yield* remember(
      yield* Schema.decodeUnknownEffect(Flows.RememberInput)({
        bank: "flow-release-notes",
        key: "release",
        text: "cut 0.1.0 with the changelog"
      })
    )
    // Empty banks recall from every policy bank.
    const rows = yield* recall({ banks: [], query: "changelog" })

    const store = yield* MemoryStore.MemoryStore
    const fact = yield* store.getFact({ namespace: "flow-release-notes", key: "release" })

    // A bank the policy does not list fails with invalid_namespace.
    const refused = yield* remember({ bank: "global-secrets", key: "k", text: "x" }).pipe(Effect.flip)

    return {
      recalledKeys: rows.map((row) => row.key),
      provenance: fact?.provenance,
      foreignBank: refused.code
    }
  }).pipe(Effect.provide(memory), Effect.runPromise)
