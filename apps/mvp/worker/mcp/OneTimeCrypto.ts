import { digestSync } from "@smthrs/crypto"
import { MCP_TOKEN_PREFIX } from "../../src/features/mcp/contract.ts"
import { ONE_TIME_TOKEN_PREFIX } from "../../src/features/trust/contract.ts"

const randomHex = (byteLength: number): string => {
  const buf = new Uint8Array(byteLength)
  crypto.getRandomValues(buf)
  let out = ""
  for (let i = 0; i < buf.length; i++) {
    out += buf[i]!.toString(16).padStart(2, "0")
  }
  return out
}

export const generateOneTimeToken = (): string => `${ONE_TIME_TOKEN_PREFIX}${randomHex(32)}`
export const generateMcpBearerToken = (): string => `${MCP_TOKEN_PREFIX}${randomHex(32)}`
export const randomUuid = (): string => crypto.randomUUID()
export const sha256Hex = (value: string): string => digestSync(value)
