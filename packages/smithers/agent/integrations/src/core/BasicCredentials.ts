/**
 * HTTP Basic credentials for OAuth clients and GitHub Apps.
 *
 * @since 0.1.0
 */

/**
 * `id:secret` with each side percent-encoded, then base64. Percent-encoding
 * leaves only ASCII, which `btoa` encodes byte for byte. A lone surrogate in
 * the id or secret is a configuration defect: `encodeURIComponent` throws for
 * it at the call, as it always has.
 *
 * @throws {never}
 * @private
 * @since 0.1.0
 */
export const basicCredentials = (id: string, secret: string): string =>
  btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)
