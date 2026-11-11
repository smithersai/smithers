/**
 * WebCrypto calls for GitHub App keys and JWT signatures.
 *
 * @since 1.0.0
 */

/**
 * Imports PKCS#8 DER as a non-extractable RS256 signing key.
 *
 * @since 1.0.0
 */
export const importSigningKey = (der: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])

/**
 * Signs `data` with an RS256 key.
 *
 * @since 1.0.0
 */
export const signRs256 = (key: CryptoKey, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> =>
  crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data)
