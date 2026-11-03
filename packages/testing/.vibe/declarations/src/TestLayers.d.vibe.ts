/**
 * Deterministic test layer bundles.
 *
 * Governing design: `packages/testing/docs/concepts/test-tiers.md`, "The unit
 * tier".
 *
 * @since 0.0.0
 */
import * as Kernel from "@smthrs/kernel";
import * as Layer from "effect/Layer";
import type { EngineSubject } from "./EngineSubject.vibe";
import { ModelLike } from "./ModelLike.vibe";
import * as TestHost from "../../../src/TestHost.ts";
/**
 * The unit-tier bundle: deterministic Host, in-memory Journal, the supplied
 * engine, and the **real** permission kernel (`/kernel` GrantStore over a
 * test Workspace, unattended so sealing violations fail typed instead of
 * suspending). Sealing violations fail in tests exactly as in production.
 *
 * @since 0.0.0
 * @category layers
 */
export declare const unit: <R, E>(engine: Layer.Layer<EngineSubject, E, R>) => Layer.Layer<EngineSubject | Kernel.GrantStore.GrantStore | import("@smthrs/journal/Journal").Journal | TestHost.TestHost, E | Kernel.Permission.GrantStoreError | import("@smthrs/journal/Journal").JournalError | import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, R>;
/**
 * Poisoned `Clock` and `Random` references. `Clock` and `Random` are
 * `Context.Reference`s with ambient defaults, so their poisoning cannot appear
 * in a layer's output type; providing this layer beneath a bundle makes any
 * unprovided time or randomness access fail loudly instead of silently using
 * the Effect defaults.
 *
 * @since 0.0.0
 * @category layers
 */
export declare const poisonedClockAndRandom: Layer.Layer<never>;
/**
 * A plan-time bundle: Host, Model, Clock, and Random access is rejected
 * instead of reaching a real environment. It deliberately does not provide an
 * engine. Governing design: `packages/testing/docs/concepts/test-tiers.md`,
 * "The plan-time tier".
 *
 * @since 0.0.0
 * @category layers
 */
export declare const poisoned: Layer.Layer<Kernel.HostServices.HostService | ModelLike>;
