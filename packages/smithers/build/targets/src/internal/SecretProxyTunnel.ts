/**
 * CONNECT tunnel lifecycle, supplied with native socket and timer capabilities.
 * @since 1.0.0
 */

import type * as NodeNet from "node:net"

/**
 * Host operations used by the CONNECT coordinator.
 * @since 1.0.0
 * @private
 */
export interface TunnelHost {
  readonly connect: (
    authority: { readonly host: string; readonly port: number },
    connected: () => void
  ) => NodeNet.Socket
  readonly setTimeout: typeof setTimeout
  readonly clearTimeout: typeof clearTimeout
}

/**
 * Connects one accepted socket and registers every pending or established teardown.
 * @since 1.0.0
 * @private
 */
export const connectTunnel = (
  socket: NodeNet.Socket,
  authority: { readonly host: string; readonly port: number },
  head: Buffer,
  tunnels: Set<() => void>,
  timeoutMs: number,
  host: TunnelHost
): void => {
  let upstream: NodeNet.Socket
  let connected = false
  try {
    upstream = host.connect(authority, () => {
      connected = true
      host.clearTimeout(deadline)
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.byteLength > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
  } catch {
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
    return
  }
  const drop = () => {
    host.clearTimeout(deadline)
    if (!connected && !socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
    else socket.destroy()
    upstream.destroy()
  }
  // A destination that black-holes the SYN never connects and never
  // errors. Without a deadline the child's CONNECT would wait for the
  // operating system's whole TCP connect timeout, so the same elapsed
  // bound as a proxy-owned request applies here.
  const deadline = host.setTimeout(drop, timeoutMs)
  const teardown = () => {
    host.clearTimeout(deadline)
    upstream.destroy()
  }
  tunnels.add(teardown)
  upstream.once("error", drop)
  socket.once("error", drop)
  socket.once("close", () => upstream.destroy())
  upstream.once("close", () => {
    tunnels.delete(teardown)
    host.clearTimeout(deadline)
    socket.destroy()
  })
}
