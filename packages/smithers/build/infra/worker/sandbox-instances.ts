/**
 * The Cloudflare container instance types the sandbox Worker deploys.
 *
 * @since 0.1.0
 */

/**
 * One instance type the sandbox Worker serves.
 *
 * `instanceType` is the Cloudflare predefined size its container application
 * runs; `cpus` and `memoryMib` are that size as `CloudflareSandbox` selects
 * by it, so they must equal what Cloudflare documents for `instanceType`.
 * `binding` is the Worker's Durable Object binding and `className` the class
 * the Worker exports for it: Cloudflare allows one container application per
 * Durable Object class, so each size has a class of its own.
 *
 * @category models
 * @since 0.1.0
 */
export interface SandboxInstanceType {
  readonly name: string
  readonly instanceType: "standard-1" | "standard-2" | "standard-3" | "standard-4"
  readonly cpus: number
  readonly memoryMib: number
  readonly binding: string
  readonly className: string
}

/**
 * The instance types, the first being the default a session without
 * ceilings gets.
 *
 * `standard-4` (4 vCPU, 12 GiB, 20 GB disk) is the largest size Cloudflare
 * offers and the one post-merge checks run on. `standard-3` (2 vCPU, 8 GiB,
 * 16 GB disk) serves a session that asks for at most 2 CPUs and 8 GiB.
 *
 * @category constants
 * @since 0.1.0
 */
export const sandboxInstanceTypes = [
  {
    name: "standard-4",
    instanceType: "standard-4",
    cpus: 4,
    memoryMib: 12_288,
    binding: "SANDBOX_STANDARD_4",
    className: "SandboxStandard4"
  },
  {
    name: "standard-3",
    instanceType: "standard-3",
    cpus: 2,
    memoryMib: 8_192,
    binding: "SANDBOX_STANDARD_3",
    className: "SandboxStandard3"
  }
] as const satisfies ReadonlyArray<SandboxInstanceType>
