// The platform code of planning-wiki-provider.vibe: the host's `fetch`, which a .vibe file does not call directly.

/** A `fetch`-shaped function the relay provider dials with; the host's own when the caller supplies none. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * Sends one request through `implementation`, or through the host's `fetch` when it is undefined. Rejects as `fetch`
 * does; callers await it inside `tryPromise`.
 */
export function relayFetch(implementation: Fetch | undefined, input: string | URL, init: RequestInit): Promise<Response> {
  return (implementation ?? fetch)(input, init)
}
