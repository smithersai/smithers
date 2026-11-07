import { Layer } from "effect";
import { Factory } from "./Factory.vibe";
/** How long the scripted agent waits between the pieces of its reply. */
export declare const MOCK_DELTA_DELAY = "25 millis";
/** The mock factory. Each layer build is its own empty world. */
export declare const MockFactory: Layer.Layer<Factory, never, never>;
