import * as Flow from "@smthrs/core/Flow"
import * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect, Schema } from "effect"
import { StorageRecoveryError } from "../chain/StorageRecovery"
import { STORAGE_RECOVERY_EXPORT, STORAGE_RECOVERY_USER_ONLY_REASON } from "../state/StorageRecoveryContract"
import type { FlowEntry } from "./registry"

const input = Schema.Struct({})
const declaration = Flow.make({
  name: STORAGE_RECOVERY_EXPORT,
  description: "Prepare a private local recovery download",
  input,
  output: Schema.Struct({}),
  capabilities: ["app:act"]
})

/** One declaration/binding factory for startup, slash, button and agent refusal. */
export const storageRecoveryExportFlow = (run: () => Promise<string | void>): FlowEntry => ({
  binding: FlowBinding.make({
    flow: declaration,
    modelInvocable: false,
    publicError: (message: string) => message,
    handler: () =>
      Effect.tryPromise({
        try: run,
        catch: () => new StorageRecoveryError("unreadable").message
      }).pipe(Effect.flatMap((refusal) => refusal === undefined ? Effect.succeed({}) : Effect.fail(refusal)))
  }),
  input,
  metadata: {
    summary: "Download a private local recovery file",
    hidden: true,
    userOnlyReason: STORAGE_RECOVERY_USER_ONLY_REASON
  }
})

/** The startup button has no app registry yet, but executes the same binding. */
export const invokeStartupRecovery = (entry: FlowEntry): Promise<Cell.CallResult> => {
  const descriptor = entry.binding.descriptor
  return Effect.runPromise(entry.binding.run(
    new Cell.Call({
      flowName: descriptor.name,
      input: {},
      capabilities: descriptor.capabilities,
      effects: descriptor.effects,
      placement: descriptor.placement,
      identity: new Cell.CallIdentity({
        session: "startup-recovery",
        frame: 0,
        cell: "startup-recovery",
        ordinal: 0,
        declaration: Cell.declarationDigest(descriptor),
        layers: []
      })
    })
  ))
}
