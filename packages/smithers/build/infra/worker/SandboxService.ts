/**
 * The hosted sandbox service: `HttpSandbox.serve` over retained Cloudflare
 * Sandbox containers.
 *
 * @since 0.1.0
 */

import * as CloudflareSandbox from "@smthrs/sandbox/CloudflareSandbox"
import * as HttpSandbox from "@smthrs/sandbox/HttpSandbox"
import * as Effect from "effect/Effect"
import { sandboxInstanceTypes } from "./sandbox-instances.ts"

/**
 * The sandbox Worker's bindings: the bearer token every request must carry,
 * and one Durable Object binding per instance type.
 *
 * @category models
 * @since 0.1.0
 */
export type SandboxWorkerEnv<Binding> =
  & { readonly SANDBOX_TOKEN?: string | undefined }
  & { readonly [Name in (typeof sandboxInstanceTypes)[number]["binding"]]: Binding }

/**
 * What the service needs besides its bindings.
 *
 * @category models
 * @since 0.1.0
 */
export interface SandboxServiceOptions<Binding> {
  /** The Cloudflare Sandbox SDK; the Worker entry passes `@cloudflare/sandbox`. */
  readonly sdk: CloudflareSandbox.Sdk<Binding>
  /** Each machine's working directory. Default `CloudflareSandbox`'s, `/workspace`. */
  readonly workdir?: string | undefined
}

const unavailable = (message: string): Response =>
  new Response(JSON.stringify({ code: "unavailable", message }), {
    status: 503,
    headers: { "content-type": "application/json" }
  })

/**
 * Builds the sandbox Worker's `fetch`.
 *
 * Every request is `HttpSandbox.serve` over a retained `CloudflareSandbox`
 * whose instance types are {@link sandboxInstanceTypes}: a session's limits
 * pick the smallest type that holds them, and a session without limits gets
 * the first. `HttpSandbox.serve` compares the bearer token itself. A Worker
 * deployed without `SANDBOX_TOKEN` answers every request `503`, so a missing
 * secret never serves machines to anyone.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeSandboxService = <Binding>(options: SandboxServiceOptions<Binding>) => ({
  fetch: (request: Request, env: SandboxWorkerEnv<Binding>): Promise<Response> => {
    const token = env.SANDBOX_TOKEN ?? ""
    if (token === "") return Promise.resolve(unavailable("the sandbox service has no SANDBOX_TOKEN"))
    const instances = sandboxInstanceTypes.map(({ binding, cpus, memoryMib, name }) => ({
      name,
      cpus,
      memoryMib,
      binding: env[binding]
    }))
    const handler = HttpSandbox.serve({
      provider: (limits) =>
        CloudflareSandbox.make({ sdk: options.sdk, retained: true, instances, limits, workdir: options.workdir }),
      token
    })
    return Effect.runPromise(handler(request))
  }
})
