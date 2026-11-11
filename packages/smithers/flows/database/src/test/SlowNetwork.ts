/**
 * A slow network in front of a test database: a local TCP proxy that holds
 * every chunk for a fixed time each way, so a suite on one machine pays the
 * round trip a Worker pays to its database through Hyperdrive.
 *
 * @since 1.0.0
 */

import { Effect, type Scope } from "effect"
import { type AddressInfo, createServer, Socket } from "node:net"
import { pipeline, Transform } from "node:stream"
import { endpoint } from "../internal/SlowNetworkTarget.ts"

/**
 * Options for {@link proxy}.
 *
 * @category models
 * @since 1.0.0
 */
export interface SlowNetworkOptions {
  /** How long each chunk waits each way, in milliseconds; a round trip costs twice this. */
  readonly delayMs: number
}

/**
 * Starts a proxy in front of the database at `url` for the enclosing scope
 * and answers the same URL pointed at the proxy. Chunks keep their order in
 * each direction, and an end arrives after the chunks before it. Closing the
 * scope closes the proxy and every connection through it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const proxy = (url: string, options: SlowNetworkOptions): Effect.Effect<string, never, Scope.Scope> =>
  Effect.gen(function*() {
    const target = endpoint(url)
    const sockets = new Set<Socket>()
    // Equal delays fire in the order they were set, so chunks keep their order.
    const slow = () =>
      new Transform({
        transform(chunk, _encoding, done) {
          setTimeout(() => this.push(chunk), options.delayMs)
          done()
        },
        flush(done) {
          setTimeout(done, options.delayMs)
        }
      })
    const server = createServer((client) => {
      const upstream = new Socket()
      for (const socket of [client, upstream]) {
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))
      }
      const close = () => {
        client.destroy()
        upstream.destroy()
      }
      pipeline(client, slow(), upstream, close)
      pipeline(upstream, slow(), client, close)
      upstream.connect(target)
    })
    const port = yield* Effect.acquireRelease(
      Effect.callback<number>((resume) => {
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed((server.address() as AddressInfo).port)))
      }),
      () =>
        Effect.callback<void>((resume) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => resume(Effect.void))
        })
    )
    const proxied = new URL(url)
    proxied.hostname = "127.0.0.1"
    proxied.port = String(port)
    return proxied.toString()
  })
