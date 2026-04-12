import type { GenerateTextResult, StreamTextResult, ToolSet } from "ai";
export declare function streamResultToGenerateResult<TOOLS extends ToolSet = {}, OUTPUT = any>(stream: StreamTextResult<TOOLS, any>, onStdout?: (text: string) => void): Promise<GenerateTextResult<TOOLS, any>>;
