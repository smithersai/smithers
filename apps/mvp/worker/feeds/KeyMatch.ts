import { digestSync } from "@smthrs/crypto"
import { Core } from "@smthrs/integrations"

const encoder = new TextEncoder()

/** Whether `presented`'s SHA-256 is `digest`, compared in constant time. */
export const keyMatches = (presented: string, digest: string): boolean =>
  Core.Signature.constantTimeEqual(encoder.encode(digestSync(presented)), encoder.encode(digest))
