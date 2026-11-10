// The platform side of infra/ElectricCache.vibe: the Worker's web `Response` class.

/**
 * Whether `body` is a web `Response`, as a raw response body the gateway relays is.
 *
 * @throws {never} `instanceof` against the runtime's `Response` class reads only the prototype chain.
 */
export const isWebResponse = (body: unknown): body is Response => body instanceof Response
