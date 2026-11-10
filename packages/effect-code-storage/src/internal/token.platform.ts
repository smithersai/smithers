/**
 * The platform code of token.vibe: the runtime's WebCrypto, which a .vibe file does not use directly (EK4402).
 *
 * @since 0.1.0
 */

/** Imports a P-256 PKCS#8 key for ES256 signing; rejects when the key is unusable or the runtime has no WebCrypto. */
export const importSigningKey = (der: Uint8Array): Promise<CryptoKey> =>
  globalThis.crypto.subtle.importKey("pkcs8", new Uint8Array(der), { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign"
  ])

/** The raw ES256 `r || s` signature of `data` under `key`. */
export const signEs256 = (key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> =>
  globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data)
