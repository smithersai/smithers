import { Layer, Schema } from "effect";
import { Factory } from "../core/Factory.vibe";
declare const LiveBackendNotDeployed_base: Schema.Class<LiveBackendNotDeployed, Schema.TaggedStruct<"LiveBackendNotDeployed", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
export declare class LiveBackendNotDeployed extends LiveBackendNotDeployed_base {
}
export declare const LIVE_BACKEND_MESSAGE = "The live Factory backend is not deployed yet. Use --mock or VIBELANG_FACTORY=mock.";
/** Backend choice belongs to the host. Replace this layer and add its flag when 1b arrives. */
export declare function backend(mock: boolean, environment: string | undefined): Layer.Layer<Factory, LiveBackendNotDeployed, never>;
export {};
