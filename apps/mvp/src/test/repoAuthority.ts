import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Layer } from "effect"
import { RepoStore } from "../features/repo/store"

// Isolated store tests still use the real authority and their supplied persistence. Hold its unrelated repository
// shape at the Effect transport boundary; feature shapes keep the test's own transport and real dependencies.
export const repoAuthority = RepoStore.layer({ origin: "https://unused.test" }).pipe(
  Layer.provide(Layer.succeed(ShapeSource.ShapeSource, { request: () => Effect.never })),
)
