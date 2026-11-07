import { type ElectricCollection } from "@smthrs/effect-electric";
import { Metric, Stream } from "effect";
/** Pull metadata's first answer, changed failure status and recovery; no repository or pull content. */
export declare const pullShapeTransitions: Metric.Counter<number>;
export declare const observePullShape: (events: Stream.Stream<ElectricCollection.SyncEvent>) => import("effect/Effect").Effect<void, never, never>;
