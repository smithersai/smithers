import { digestSync } from "@smthrs/crypto"
import { Effect } from "effect"
import type { Change } from "./Stack.vibe"

/** A change's payload hash: the repository, who it acts for and the change, never its op id. */
export const payloadHash = (change: Change): string =>
  digestSync(JSON.stringify({ repoId: change.repoId, ...(change.op.kind === "retry" ? { actorId: change.actor.id } : {}), via: change.via, ...change.op }))

export const randomAttemptId = Effect.sync(() => crypto.randomUUID())
