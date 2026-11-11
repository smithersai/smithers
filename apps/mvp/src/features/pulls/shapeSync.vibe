import { type ElectricCollection } from "@smthrs/effect-electric"
import { Metric, Stream } from "effect"
import { observeShape } from "../issues/shapeSync"

/** Pull metadata's first answer, changed failure status and recovery; no repository or pull content. */
export const pullShapeTransitions = Metric.counter("smithers_pull_shape_transitions", {
  description: "Meaningful browser pull shape states, by phase",
  incremental: true,
})

export const observePullShape = (events: Stream.Stream<ElectricCollection.SyncEvent>) =>
  observeShape(events, "pulls.shape.sync", pullShapeTransitions)
