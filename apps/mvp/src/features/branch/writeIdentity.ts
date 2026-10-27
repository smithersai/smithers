import { Uuid } from "@smthrs/crypto"
import { Effect } from "effect"
import { CONVERSATION_NAMESPACE } from "./contract"

/** Both the optimistic launch and the durable operation name the same server receipt. */
export const operationWriteId = (operation: "publish" | "update", executionId: string) =>
  Uuid.v5(CONVERSATION_NAMESPACE, `${operation}:${executionId}`).pipe(Effect.orDie)
