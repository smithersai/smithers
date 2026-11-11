import { Clock, Effect, Exit, Scope } from "effect"
import { afterEach } from "vitest"
import { createHostDiagnostics as create, type HostDiagnosticOptions } from "../src/HostDiagnostics.vibe"

const scopes = new Set<Scope.Closeable>()
afterEach(async () => {
  for (const scope of scopes) await Effect.runPromise(Scope.close(scope, Exit.void))
  scopes.clear()
})

/** Each test owns its injected clock and diagnostic observation scope. */
export const createHostDiagnostics = (options: HostDiagnosticOptions = {}) => {
  const scope = Scope.makeUnsafe()
  scopes.add(scope)
  return create({ ...options, runtime: { clock: Effect.runSync(Clock.Clock), scope } })
}
