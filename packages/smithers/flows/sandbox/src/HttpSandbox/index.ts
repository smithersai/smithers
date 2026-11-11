/**
 * The HTTP sandbox provider and the service it speaks to.
 *
 * `serve` turns a retained `Sandbox.Provider` into a handler on web-standard
 * `Request` and `Response`, which a Cloudflare Worker mounts over
 * `CloudflareSandbox`. `make` is the `Sandbox.Provider` a host constructs to
 * reach that service with a URL, a bearer token and an Effect `HttpClient`.
 * Commands run detached in the machine and are polled with short requests,
 * so no request lives as long as the command it starts.
 *
 * @since 1.0.0-rc.17
 */

export * from "./make.ts"
export * from "./serve.ts"
