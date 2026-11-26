import { digestSync } from "@smthrs/crypto"

const hexToBase64 = (hex: string) => btoa(String.fromCharCode(...hex.match(/../g)!.map((pair) => parseInt(pair, 16))))

export const scriptDigest = (script: string): string => hexToBase64(digestSync(script))

export const randomUUID = () => crypto.randomUUID()
