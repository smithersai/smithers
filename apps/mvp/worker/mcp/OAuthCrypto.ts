import { digestSync } from "@smthrs/crypto"
import { MCP_TOKEN_PREFIX } from "../../src/features/mcp/contract.ts"
import { timingSafeEqualString, validateCodeVerifier } from "./Pkce.ts"

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

const bytesToHex = (bytes: Uint8Array): string => {
  let out = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0")
  }
  return out
}

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

const randomBytes = (length: number): Uint8Array => {
  const buf = new Uint8Array(length)
  globalThis.crypto.getRandomValues(buf)
  return buf
}

/** Generates a 32-byte cryptographically random URL-safe authorization code (43 base64url chars). */
export const generateAuthCode = (): string => bytesToBase64Url(randomBytes(32))

/** Generates a 16-byte cryptographically random dynamic OAuth client identifier (`smc_<32 hex>`). */
export const generateClientId = (): string => `smc_${bytesToHex(randomBytes(16))}`

/** Generates a 32-byte cryptographically random opaque MCP bearer token (`sma_<64 lowercase hex>`). */
export const generateMcpToken = (): string => `${MCP_TOKEN_PREFIX}${bytesToHex(randomBytes(32))}`

/** Computes RFC 7636 PKCE S256 challenge: `base64url(SHA-256(ASCII(verifier)))` without padding. */
export const pkceS256 = (verifier: string): string => bytesToBase64Url(hexToBytes(digestSync(verifier)))

/** Verifies PKCE S256 (`base64url(SHA-256(verifier)) === challenge`) in constant time. */
export const verifyPkceS256 = (verifier: string, challenge: string, isValidChallenge: (value: string) => boolean): boolean =>
  validateCodeVerifier(verifier) && isValidChallenge(challenge) && timingSafeEqualString(pkceS256(verifier), challenge)
