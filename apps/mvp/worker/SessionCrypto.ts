import { digestSync } from "@smthrs/crypto"
import { Effect } from "effect"

export const digestSessionValue = (value: string): string => digestSync(value)

export const cleanupId = Effect.sync(() => crypto.randomUUID())

export const digestEffect = (value: string) => Effect.sync(() => digestSessionValue(value))
