import type { UpdateTrigger } from "./pwa"

// What the page's host saw go wrong that the app's program records (src/boot.ts `logHostRecords`): React's render
// errors (main.tsx's root) and the service worker's registration, install, update checks and parked reloads
// (src/pwa.ts). The host sees some before the program starts, so they wait here until it listens. Names and outcomes
// only: never an error's message or a component's props. Nothing here imports a library.

/** One thing the host saw. */
export type HostRecord =
  /** React caught a render error in a boundary (`caught`), or nothing caught it and the root unmounted (`uncaught`). */
  | { readonly _tag: "render"; readonly boundary: "caught" | "uncaught"; readonly name: string }
  /** The service worker couldn't be registered. */
  | { readonly _tag: "pwa.register"; readonly name: string }
  /** A service worker that was installing became redundant before it installed. */
  | { readonly _tag: "pwa.install" }
  /** Asking the browser to check for a new service worker failed. */
  | { readonly _tag: "pwa.update.check"; readonly trigger: UpdateTrigger }
  /** A new release activated and the page reloads into it, or an editor's unsaved write held the reload back. */
  | { readonly _tag: "pwa.update"; readonly outcome: "activated" | "editor_unpersisted" }

/** Where the host puts what it saw, and where the program hears it. */
export interface HostRecords {
  readonly record: (record: HostRecord) => void
  /** Hears every record, those made before it listened first; answers how to stop. One listener at a time. */
  readonly listen: (listener: (record: HostRecord) => void) => () => void
}

/** How many records wait for a listener at most; past it, newer ones are dropped. */
export const MAX_WAITING = 50

/** A channel whose records wait, up to {@link MAX_WAITING}, until the program listens. */
export const hostRecords = (): HostRecords => {
  let listener: ((record: HostRecord) => void) | undefined
  const waiting: Array<HostRecord> = []
  return {
    record: (record) => {
      if (listener !== undefined) listener(record)
      else if (waiting.length < MAX_WAITING) waiting.push(record)
    },
    listen: (next) => {
      listener = next
      for (const record of waiting.splice(0)) next(record)
      return () => {
        if (listener === next) listener = undefined
      }
    },
  }
}

/** A thrown value's name for a record: an error's name, else its type; never its message. */
export const thrownName = (thrown: unknown): string => (thrown instanceof Error ? thrown.name : typeof thrown)
