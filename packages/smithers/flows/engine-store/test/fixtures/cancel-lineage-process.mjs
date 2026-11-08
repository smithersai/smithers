// Independent process, connection, driver and implementation registry.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import * as RunDriver from "../../src/internal/RunDriver.ts"
import * as TestStores from "../../src/test/TestStores.ts"

const [filename, executionId] = process.argv.slice(2)
if (!filename || !executionId) throw new Error("Expected fixture database and execution ID")
const flow = Flow.make("LineageCancel/First", {
  payload: {}, success: Schema.String, body: () => Node.succeed("inert")
})
await Effect.runPromise(Effect.gen(function*() {
  const driver = yield* RunDriver.make({
    owner: { hostId: "cancel-process", pid: process.pid, nonce: "cancel-process" },
    journalSource: "cancel-process",
    engine: Effect.succeed({})
  })
  yield* driver.interrupt(flow, executionId)
}).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(filename)), Effect.provide(NodeCrypto.layer)))
process.stdout.write(JSON.stringify({ requested: executionId }) + "\n")
