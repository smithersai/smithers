/**
 * Synchronous staging at a browser input boundary, until an asynchronous device
 * write is acknowledged. A newer input cannot be removed by an older receipt.
 * Storage refusal leaves the caller's in-memory editor usable.
 * @since 1.0.0
 */

/**
 * The tab-scoped storage capability supplied by the browser boundary.
 * @category models
 * @since 1.0.0
 */
export interface Storage {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
  readonly removeItem: (key: string) => void
}

/**
 * A staged value and its asynchronous write receipt.
 * @category models
 * @since 1.0.0
 */
export interface Service {
  readonly stage: (value: unknown) => string | undefined
  readonly read: () => { readonly token: string; readonly value: unknown } | undefined
  readonly acknowledge: (token: string) => void
  readonly clear: () => void
}

/**
 * The caller supplies a tab-scoped session-storage key. Values never enter logs.
 * These synchronous operations belong at the DOM/React input boundary; the
 * durable write itself remains an Effect and its receipt calls acknowledge.
 * @category constructors
 * @since 1.0.0
 */
export const make = (storage: Storage, key: string, owner?: () => string | undefined): Service => ({
  stage: (value) => {
    try {
      const scope = owner?.()
      if (owner !== undefined && scope === undefined) return undefined
      const token = JSON.stringify(owner === undefined ? value : { owner: scope, value })
      if (token === undefined) return undefined
      storage.setItem(key, token)
      return token
    } catch {
      return undefined
    }
  },
  read: () => {
    try {
      const token = storage.getItem(key)
      if (token === null) return undefined
      const parsed: unknown = JSON.parse(token)
      if (owner === undefined) return { token, value: parsed }
      const scope = owner()
      if (
        scope === undefined || typeof parsed !== "object" || parsed === null || !("owner" in parsed) ||
        parsed.owner !== scope || !("value" in parsed)
      ) return undefined
      return { token, value: parsed.value }
    } catch {
      return undefined
    }
  },
  acknowledge: (token) => {
    try {
      if (storage.getItem(key) === token) storage.removeItem(key)
    } catch {
      // A refused cleanup never discards the visible edit.
    }
  },
  clear: () => {
    try {
      storage.removeItem(key)
    } catch {
      // The host's sign-out wipe still fences the device.
    }
  }
})
