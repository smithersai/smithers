/**
 * The `@smthrs/control` `DispatchReader` port served from a `TriggerStore`.
 *
 * `Control.list` answers `{ _tag: "triggers" }` and `{ _tag: "fires" }` through
 * the port declared in `@smthrs/control/DispatchReader`. The port lives there
 * because this package depends on control (the scheduler launches runs through
 * it); the adapter lives here because only this package can read the store.
 * The host composes the two: {@link layer} over the same store the scheduler
 * writes.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 1.0.0-rc.0
 */
import { type FireSummary, type TriggerSummary } from "@smthrs/control/ControlSchema";
import * as Port from "@smthrs/control/DispatchReader";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { TriggerError } from "./TriggerError.vibe";
import { type FireRecord, type Held, type Registered, TriggerStore } from "../../../src/TriggerStore.ts";
/**
 * How many upcoming occurrences a trigger summary carries.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const nextOccurrenceCount = 5;
/**
 * The next {@link nextOccurrenceCount} occurrences strictly after `now`, as
 * epoch milliseconds in ascending order.
 *
 * @category getters
 * @since 1.0.0-rc.0
 */
export declare const nextOccurrences: (trigger: Pick<Registered, "cron" | "timezone">, now: number) => Effect.Effect<ReadonlyArray<number>, TriggerError>;
/**
 * Maps one stored trigger and what it holds to the control plane's summary.
 *
 * A launch reservation is not a run the runtime knows about, so it is
 * reported as no active run; the ledger still shows the claimed occurrence.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const toTriggerSummary: (trigger: Registered, held: Held, nextOccurrencesMs: ReadonlyArray<number>, schedulerLastTickMs: Option.Option<number>) => TriggerSummary;
/**
 * Maps one ledger row to the control plane's fire summary.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const toFireSummary: (record: FireRecord) => FireSummary;
/**
 * Builds the port over the ambient {@link TriggerStore}.
 *
 * `list` answers every trigger the store holds, taking each row's held state
 * from the listing itself; `fires` pushes the request's filters into the
 * ledger query and answers the matching rows newest first, reading only as
 * many as the requested page needs.
 * `Control.list` applies the filters again and pages. A store failure is a
 * `PersistenceError` naming the listing that failed.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const make: Effect.Effect<Port.Service, never, TriggerStore>;
/**
 * Provides the control plane's `DispatchReader` from the ambient
 * {@link TriggerStore}, so `Control.list` answers `triggers` and `fires` from
 * the store the scheduler writes.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export declare const layer: Layer.Layer<Port.DispatchReader, never, TriggerStore>;
