/** Copy Effect HTTP response headers into the Worker fetch headers used by rate-limit classification. */
export const responseHeaders = (headers: Readonly<Record<string, string>>): Headers => new Headers(headers)
