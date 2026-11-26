import { digestSync } from "@smthrs/crypto"

// Scheduled execution IDs are synchronous and use the first 16 hex digits of the trigger ID's SHA-256.
export const triggerDigest = (trigger: string): string => digestSync(trigger).slice(0, 16)
