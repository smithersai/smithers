// The engine worker's first module (src/flows/engine.worker.ts imports it before every other), so it runs before the
// rest of the worker's bundle evaluates: it starts the worker's first session read, which src/flows/sessionRead.ts
// hands to the device's owner check. Part of the worker's program boundary, named like it: it calls the worker's own
// `fetch`.
import { SESSION_ROUTE } from "../features/auth/contract"

/** The worker's first session read, started as its bundle loads. A failure nothing has read yet is never unhandled. */
export const started: Promise<Response> = self.fetch(`${self.location.origin}${SESSION_ROUTE}`)
// expected: observe early rejection only; firstReadFrom returns the original rejected promise to the device owner check.
started.catch(() => undefined)
