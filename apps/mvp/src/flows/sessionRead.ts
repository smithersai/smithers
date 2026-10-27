// The engine worker's first session read, which its bundle starts before anything else loads
// (src/flows/sessionStart.worker.ts). That read decides whose data the device holds before the engine opens its store
// (src/device/identity.ts); started as the bundle begins to load, its round trip runs while the worker evaluates every
// flow module instead of after (docs/decisions/0117-cold-start.md).

/** What a `fetch` is called with, as the worker's `HttpClient` calls it. */
type Input = string | URL | Request

const hrefOf = (input: Input): string => (input instanceof Request ? input.url : new URL(input).href)

/**
 * A `fetch` that answers its first `GET` of `url` with `started`, a request the worker made before this existed, and
 * every other request, the later reads of `url` among them, with `network`, the worker's own `fetch`. So the worker's
 * first session read takes the response it started as it loaded, and every later read, such as an adoption's, asks
 * again. Without `started` it is `network`.
 */
export const firstReadFrom = (
  network: typeof globalThis.fetch,
  url: string,
  started: Promise<Response> | undefined,
): typeof globalThis.fetch => {
  let waiting = started
  const target = new URL(url).href
  return (input, init) => {
    const first = waiting
    if (first === undefined || hrefOf(input) !== target || (init?.method ?? "GET").toUpperCase() !== "GET") {
      return network(input, init)
    }
    waiting = undefined
    return first
  }
}
