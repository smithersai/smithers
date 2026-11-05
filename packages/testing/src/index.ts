/**
 * Layered testing, conformance, and assertion utilities for flows.
 *
 * The vitest adapter is deliberately absent from this barrel. `vitest` refuses
 * to load through `require()` and throws a message about bundlers, so a barrel
 * that re-exported it would make `require("@smthrs/testing")` fail for every
 * CommonJS consumer of the assertion helpers. Import it by its own subpath
 * instead: `import { ... } from "@smthrs/testing/Vitest"`, which is ESM-only
 * because vitest is.
 *
 * @since 0.0.0
 */

/** @since 0.0.0 @category errors */
export * as TestingError from "./TestingError.ts"

/** @since 0.0.0 @category models */
export * as PlanLike from "./PlanLike.ts"

/** @since 0.0.0 @category services */
export * as EngineSubject from "./EngineSubject.vibe"

/** @since 0.0.0 @category services */
export * as ModelLike from "./ModelLike.vibe"

/** @since 0.0.0 @category layers */
export * as TestLayers from "./TestLayers.vibe"

/** @since 0.0.0 @category assertions */
export * as Plan from "./Plan.vibe"

/** @since 0.0.0 @category assertions */
export * as PlanAssertions from "./PlanAssertions.vibe"

/** @since 0.0.0 @category assertions */
export * as JournalAssertions from "./JournalAssertions.vibe"

/** @since 0.0.0 @category assertions */
export * as Divergence from "./Divergence.vibe"

/** @since 0.0.0 @category conformance */
export * as Conformance from "./Conformance.vibe"

/** @since 0.0.0 @category models */
export * as RecordedModel from "./RecordedModel.vibe"

/** @since 0.0.0 @category models */
export * as RecordingModel from "./RecordingModel.ts"

/** @since 0.0.0 @category models */
export * as CachedModel from "./CachedModel.vibe"

/** @since 1.0.0 @category models */
export * as CachedEvaluator from "./CachedEvaluator.ts"

/** @since 1.0.0 @category models */
export * as TurnGate from "./TurnGate.vibe"

/** @since 1.0.0 @category models */
export * as ScriptedModel from "./ScriptedModel.vibe"

/** @since 1.0.0 @category models */
export * as BuiltinScript from "./BuiltinScript.vibe"

/** @since 0.0.0 @category fixtures */
export * as Fixture from "./Fixture.vibe"

/** @since 0.0.0 @category services */
export * as FixtureStore from "./FixtureStore.ts"

/** @since 0.0.0 @category layers */
export * as MemoryEngine from "./MemoryEngine.ts"

/** @since 0.0.0 @category layers */
export * as FlowEngineLike from "./FlowEngineLike.ts"

/** @since 0.0.0 @category testing */
export * as RestartableEngine from "./RestartableEngine.vibe"

/** @since 0.0.0 @category conformance */
export * as HostSuite from "./HostSuite.ts"

/** @since 0.0.0 @category assertions */
export * as ScoreGate from "./ScoreGate.ts"
