/**
 * Shared endpoint normalization for the remote control transports.
 *
 * @since 1.0.0
 */

const rpcBase = (remote: string): URL => {
  const url = new URL(remote)
  const path = url.pathname.replace(/\/+$/, "")
  url.pathname = path.endsWith("/rpc") ? path : `${path}/rpc`
  return url
}

/**
 * The unary HTTP endpoint, preserving the caller's query and fragment.
 *
 * @category conversions
 * @since 1.0.0
 */
export const rpcUrl = (remote: string): string => rpcBase(remote).toString()

/**
 * The streaming endpoint on the same RPC base, without query or fragment.
 *
 * @category conversions
 * @since 1.0.0
 */
export const websocketUrl = (remote: string): string => {
  const url = rpcBase(remote)
  url.pathname += "/ws"
  url.search = ""
  url.hash = ""
  return url.toString()
}
