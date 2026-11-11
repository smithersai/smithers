// The platform code of run-history.vibe: the host's `fetch`, which a .vibe file does not call.

/** The platform `fetch`, looked up per call, for a gateway that supplies none. */
export const defaultFetch = (url: string, init?: RequestInit): Promise<Response> => fetch(url, init)
