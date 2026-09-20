/** Real fetch, with Bun connection reuse disabled only for this owned relay. */
export const relayFetch = (origin: string, send: typeof fetch): typeof fetch => Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = new URL(input instanceof Request ? input.url : input)
    if (target.origin !== origin) return send(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set("connection", "close")
    return send(input, { ...init, headers, keepalive: false })
  },
  { preconnect: send.preconnect }
)
