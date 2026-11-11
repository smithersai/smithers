/**
 * The upstream endpoint used by the test database proxy.
 *
 * @since 1.0.0
 */

/**
 * Resolves an explicit PostgreSQL port or its protocol default.
 *
 * @private
 * @since 1.0.0
 */
export const endpoint = (url: string): { readonly host: string; readonly port: number } => {
  const target = new URL(url)
  return { host: target.hostname, port: Number(target.port || 5432) }
}
