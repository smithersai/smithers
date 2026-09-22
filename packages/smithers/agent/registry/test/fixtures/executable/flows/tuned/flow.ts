"use sandbox"

import { Annotations, Flow } from "@smthrs/core"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Schema } from "effect"

export default Flow.make({
  name: "tuned",
  description: "Carries a cache policy, a priority, and a placement directive.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ greeting: Schema.String }),
  flows: ["test/echo"],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
}).pipe(
  Flow.annotate(Annotations.Priority, 7),
  Flow.annotate(CacheEnvironment.CachePolicyAnnotation, { ttlMs: 60_000, scope: "shared" })
)
