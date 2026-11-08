// The platform code of host.vibe, and its plain TypeScript that throws: Node's
// paths and process, the host's random id, and the panel member's refusing ports.
import { realpathSync } from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import type * as Runtime from "#vibelang/emitted/src/runtime"
import * as Subprocess from "./subprocess.ts"

/**
 * Resolve aliases even before a lazily-created session directory exists.
 * @throws {never}
 */
export function physicalPath(path: string): string {
  let ancestor = resolve(path)
  const missing: Array<string> = []
  for (;;) {
    try {
      return join(realpathSync(ancestor), ...missing.toReversed())
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) return resolve(path)
      missing.push(basename(ancestor))
      ancestor = parent
    }
  }
}

/**
 * `to` relative to `from`, with forward slashes on every platform.
 * @throws {never}
 */
export function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/")
}

/**
 * This process's id.
 * @throws {never}
 */
export function processPid(): number {
  return process.pid
}

/**
 * Whether `program` resolves on this process's `PATH`.
 * @throws {never}
 */
export function hasProgram(program: string): boolean {
  return Subprocess.which(program, process.env) !== null
}

/**
 * Eight hex characters unique to this host.
 * @throws {never}
 */
export function randomHostId(): string {
  return crypto.randomUUID().slice(0, 8)
}

/** A panel member only answers its task: every runtime port refuses. */
export const memberRefusal = "A panel member only answers its task; it cannot publish, delegate, wait, ask or answer"
export const memberPorts: Runtime.Ports = {
  publish: () => {
    throw new Error(memberRefusal)
  },
  delegate: () => {
    throw new Error(memberRefusal)
  },
  wait: () => Promise.reject(new Error(memberRefusal)),
  ask: () => Promise.reject(new Error(memberRefusal)),
  answer: () => {
    throw new Error(memberRefusal)
  }
}
