import type { MemoryProcessor } from "./MemoryProcessor";
export declare function Summarizer(agent: {
    run: (prompt: string) => Promise<any>;
}): MemoryProcessor;
