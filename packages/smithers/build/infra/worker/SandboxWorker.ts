/**
 * Cloudflare Worker entry point for the hosted sandbox service.
 *
 * This module only binds the Cloudflare Sandbox SDK, which loads only inside
 * the Workers runtime; the service itself is `SandboxService.ts`, where the
 * suite runs it against a fake of the same SDK slice.
 *
 * @since 0.1.0
 */

import { getSandbox, Sandbox } from "@cloudflare/sandbox"
import { makeSandboxService } from "./SandboxService.ts"

/**
 * The Durable Object class behind the `standard-4` instance type.
 *
 * @category runtime
 * @since 0.1.0
 */
export class SandboxStandard4 extends Sandbox {}

/**
 * The Durable Object class behind the `standard-3` instance type.
 *
 * @category runtime
 * @since 0.1.0
 */
export class SandboxStandard3 extends Sandbox {}

/**
 * Cloudflare Worker entry point for the hosted sandbox service.
 *
 * @category runtime
 * @since 0.1.0
 */
const worker = makeSandboxService<DurableObjectNamespace<Sandbox>>({ sdk: { getSandbox } })

export default worker
