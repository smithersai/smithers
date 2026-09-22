"use server"

import { Flow } from "@smthrs/core"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Schema } from "effect"

/**
 * The `cacheable` fixture with one field changed: a one-millisecond `ttlMs`.
 *
 * The suite advances its test clock by ten milliseconds between the two runs,
 * so the row the first run records is past its age bound when the second run
 * reads it, and the age the engine measures is stated rather than timed.
 */
export default Flow.make({
  name: "cacheable-expiring",
  description: "Delegates to the agent and expires its recorded result at once.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ greeting: Schema.String }),
  flows: [],
  capabilities: [],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
}).pipe(Flow.annotate(CacheEnvironment.CachePolicyAnnotation, { ttlMs: 1, scope: "shared" }))
