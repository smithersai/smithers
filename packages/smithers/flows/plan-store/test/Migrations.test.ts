import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as initialModule from "../src/internal/migrations/0001_initial.ts"
import * as appendOnlyHardeningModule from "../src/internal/migrations/0002_append_only_hardening.ts"
import * as forwardOnlyIdentityModule from "../src/internal/migrations/0003_forward_only_identity.ts"
import * as Migrations from "../src/Migrations.ts"

/**
 * Every step module beside the binding it exports. A default export would
 * compile to `exports.default` in the CommonJS build, and Node's interop would
 * then hand `Migrations` the whole exports object instead of the Effect.
 */
const steps = {
  "0001_initial": { module: initialModule, step: initialModule.initial },
  "0002_append_only_hardening": {
    module: appendOnlyHardeningModule,
    step: appendOnlyHardeningModule.appendOnlyHardening
  },
  "0003_forward_only_identity": {
    module: forwardOnlyIdentityModule,
    step: forwardOnlyIdentityModule.forwardOnlyIdentity
  }
} as const

describe("Migrations", () => {
  it("composes every step into the set as an Effect", () => {
    expect(Object.keys(Migrations.set.migrations)).toEqual(Object.keys(steps))
    for (const [id, migration] of Object.entries(Migrations.set.migrations)) {
      expect(typeof (migration as { readonly pipe?: unknown }).pipe, id).toBe("function")
      expect(Effect.isEffect(migration), id).toBe(true)
    }
  })

  it("exports each step by name and never as a default export", () => {
    for (const [id, { module, step }] of Object.entries(steps)) {
      expect("default" in module, id).toBe(false)
      expect(Migrations.set.migrations[id], id).toBe(step)
    }
  })
})
