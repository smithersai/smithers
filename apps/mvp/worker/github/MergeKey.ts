import { digestSync } from "@smthrs/crypto"

/**
 * The key a merge carries in its commit message: SHA-256 of the write id, which the route recorded before the flow
 * started, so every attempt and every run of this write derives the same one and no other write does.
 */
export const mergeKeyOf = (writeId: string): string => digestSync(`smithers/pr-merge/v1\n${writeId}`)
