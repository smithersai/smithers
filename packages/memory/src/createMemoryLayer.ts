import { Layer } from "effect";
import { MemoryService } from "./MemoryService";
import type { MemoryLayerConfig } from "./MemoryLayerConfig";
export declare function createMemoryLayer(config: MemoryLayerConfig): Layer.Layer<MemoryService, never, never>;
