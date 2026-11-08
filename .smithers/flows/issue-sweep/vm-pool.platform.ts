// The platform code of vm-pool.vibe: random tokens and POSIX path arithmetic, which a .vibe file does not reach.
import { randomUUID } from "node:crypto"
import { posix } from "node:path"

/**
 * A fresh random token.
 * @throws {never}
 */
export function newToken(): string {
  return randomUUID()
}

/**
 * `path` resolved against `base` with POSIX rules, as the guest sees it.
 * @throws {never}
 */
export function resolveGuestPath(base: string, path: string): string {
  return posix.resolve(base, path)
}
