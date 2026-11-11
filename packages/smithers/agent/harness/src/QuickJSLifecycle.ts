/**
 * Portable lifecycle primitives shared by cell and presentation realms.
 * Security policy remains with each consumer: these helpers neither install a
 * host bridge nor harden presentation objects.
 *
 * @since 1.0.0-rc.16
 */

import type { QuickJSWASMModule } from "quickjs-emscripten-core"

/**
 * Keep the interpreter under the host stack: each QuickJS byte costs roughly
 * three host bytes. A host overflow leaves an unsafe, undisposable runtime.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export const stackBytes = 128 * 1024

/**
 * Deterministic globals removed by both consumers. Presentation also removes
 * weak references; the harness retains its own persistent-realm policy.
 *
 * @category constructors
 * @since 1.0.0-rc.16
 */
export const prelude = (additionalGlobals: ReadonlyArray<string>): string =>
  ["Date", "Proxy", ...additionalGlobals].map((name) => `delete globalThis[${JSON.stringify(name)}];`).join("\n") +
  "\ndelete Math.random;"

const quarantined = new WeakSet<QuickJSWASMModule>()

/**
 * Refuse further allocations after one runtime becomes unsafe to dispose.
 * Shared across every consumer and service using the same compiled module.
 *
 * @category mutations
 * @since 1.0.0-rc.16
 */
export const abandon = (module: QuickJSWASMModule): void => {
  quarantined.add(module)
}

/**
 * Whether the module may allocate another runtime.
 *
 * @category predicates
 * @since 1.0.0-rc.16
 */
export const isQuarantined = (module: QuickJSWASMModule): boolean => quarantined.has(module)

/**
 * A resettable synchronous interrupt deadline and poll budget. Paused host
 * calls refund compute time, while each consumer keeps its total wall clock.
 *
 * @category constructors
 * @since 1.0.0-rc.16
 */
export const interruptBudget = (now: () => number) => {
  let deadline = Infinity
  let budget = Infinity
  let steps = 0
  let hit: "time" | "steps" | undefined
  return {
    arm: (ms: number, polls: number | undefined): void => {
      deadline = now() + ms
      budget = polls ?? Infinity
      steps = 0
      hit = undefined
    },
    pause: (ms: number): void => {
      deadline += ms
    },
    poll: (): "time" | "steps" | undefined => {
      if (now() >= deadline) hit ??= "time"
      else if (++steps > budget) hit ??= "steps"
      return hit
    }
  }
}

/**
 * UTF-8 length without allocating an encoded buffer. Lone surrogates count as
 * the three-byte replacement character, matching TextEncoder.
 *
 * @category conversions
 * @since 1.0.0-rc.16
 * @throws {never}
 */
export const utf8Length = (text: string): number => {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}
