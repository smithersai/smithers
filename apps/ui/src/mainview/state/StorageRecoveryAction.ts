import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { z } from "zod"
import { encodeStorageRecovery, StorageRecoveryError } from "../chain/StorageRecovery"
import type { StorageRecoverySnapshot } from "../chain/StorageRecovery"
import { RECOVERY_HUMAN_ONLY } from "./StorageRecoveryContract"
const CANCELED = "Recovery was canceled because the app closed. Saved data was not reset."

const RecoveryStateSchema = z.object({
  id: z.literal("recovery"),
  phase: z.enum(["idle", "preparing", "ready", "failed", "canceled"]),
  message: z.string().nullable(),
  actor: z.enum(["system", "user", "smithers"]),
  revision: z.number().int().nonnegative()
})
type RecoveryState = z.infer<typeof RecoveryStateSchema>

export interface StorageRecoveryHost {
  readonly read: () => Promise<StorageRecoverySnapshot>
  /** A local browser handoff, never an HTTP upload or model/tool output. */
  readonly download: (json: string) => void | Promise<void>
}

/**
 * The same recovery act on a healthy page or before AppStore can boot. Only
 * ephemeral operation status lives here; private bytes never enter the state
 * projection. Every status change uses this dispatcher and records its actor.
 * A separate in-memory collection is necessary because the durable AppStore
 * may be the resource that refused to open.
 */
export const createStorageRecoveryAction = (host: StorageRecoveryHost, actor: "user" | "smithers") => {
  const state = createCollection(localOnlyCollectionOptions({
    id: `storage-recovery-${crypto.randomUUID()}`,
    schema: RecoveryStateSchema,
    getKey: (row) => row.id,
    initialData: [{ id: "recovery", phase: "idle", message: null, actor: "system", revision: 0 }]
  }))
  let disposed = false
  let pending: Promise<string | void> | undefined
  let closing: Promise<void> | undefined
  const dispatch = async (phase: RecoveryState["phase"], message: string | null): Promise<void> => {
    await state.update("recovery", (draft) => {
      draft.phase = phase
      draft.message = message
      draft.actor = actor
      draft.revision += 1
    }).isPersisted.promise
  }

  const run = (): Promise<string | void> => {
    // This host-owned actor check remains necessary even if a caller bypasses
    // the registry's modelInvocable filtering and invokes the binding directly.
    if (actor !== "user") return Promise.resolve(RECOVERY_HUMAN_ONLY)
    if (disposed) return Promise.resolve(CANCELED)
    if (pending !== undefined) return pending
    pending = (async () => {
      await state.preload()
      if (disposed) return CANCELED
      await dispatch("preparing", null)
      try {
        const snapshot = await host.read()
        if (disposed) {
          await dispatch("canceled", CANCELED)
          return CANCELED
        }
        const json = encodeStorageRecovery(snapshot)
        await host.download(json)
        await dispatch("ready", "Recovery download prepared.")
      } catch (error) {
        // Raw SQLite errors may carry user data. Only our closed public error
        // vocabulary reaches the state, flow result, transcript or telemetry.
        const message = disposed
          ? CANCELED
          : new StorageRecoveryError(error instanceof StorageRecoveryError ? error.code : "unreadable").message
        await dispatch(disposed ? "canceled" : "failed", message)
        return message
      }
    })().finally(() => {
      pending = undefined
    })
    return pending
  }

  const dispose = (): Promise<void> => {
    if (closing !== undefined) return closing
    disposed = true
    closing = (async () => {
      try {
        await pending
      } finally {
        await state.cleanup()
      }
    })()
    return closing
  }
  /** A failed lazy binding load is still a visible, private-safe Flux transition. */
  const bindingUnavailable = async (): Promise<void> => {
    if (disposed || actor !== "user") return
    await state.preload()
    if (!disposed) await dispatch("failed", new StorageRecoveryError("unreadable").message)
  }
  return { state, run, dispose, bindingUnavailable }
}

export type StorageRecoveryAction = ReturnType<typeof createStorageRecoveryAction>
