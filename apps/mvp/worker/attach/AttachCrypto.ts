export const digest = (bytes: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> =>
  crypto.subtle.digest("SHA-256", bytes)

export const randomBytes = (bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(bytes)
