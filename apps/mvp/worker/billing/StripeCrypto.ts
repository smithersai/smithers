// Pure WebCrypto HMAC-SHA256 verification for Stripe webhooks (works in Cloudflare Workers, Node, and Bun).
// Zero Node-only imports (SDK-4).

/** Replay tolerance window for Stripe webhook timestamps (5 minutes, Stripe default). */
export const STRIPE_TOLERANCE_SECONDS = 300

export interface ParsedStripeSignature {
  readonly timestamp: number
  readonly signatures: ReadonlyArray<string>
}

/** Parses `Stripe-Signature: t=<unix>,v1=<hex>,...` into timestamp and v1 signatures. */
/** @throws {never} */
export function parseStripeSignature(header: string): ParsedStripeSignature | undefined {
  let timestamp: number | undefined
  const signatures: Array<string> = []
  for (const part of header.split(",")) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const val = part.slice(eq + 1).trim()
    if (key === "t") {
      if (!/^\d+$/.test(val)) return undefined
      timestamp = Number(val)
    } else if (key === "v1" && /^[0-9a-fA-F]{64}$/.test(val)) {
      signatures.push(val.toLowerCase())
    }
  }
  if (timestamp === undefined || signatures.length === 0) return undefined
  return { timestamp, signatures }
}

/** Constant-time equality over equal-length UTF-8/ASCII hex strings. */
/** @throws {never} */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/** Computes lowercase hex HMAC-SHA256(`${timestamp}.${payload}`) using WebCrypto. */
export async function computeStripeHmacHex(
  secret: string,
  timestamp: number,
  rawBody: string,
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`))
  const bytes = new Uint8Array(mac)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex
}

/**
 * Returns a fresh v4 UUID via WebCrypto.
 * @throws {never}
 */
export function randomUuid(): string {
  return crypto.randomUUID()
}
