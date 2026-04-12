type AgentStdoutTextEmitterOptions = {
    outputFormat?: string;
    onText?: (text: string) => void;
};
type AgentStdoutTextEmitter = {
    push: (chunk: string) => void;
    flush: (finalText?: string) => void;
};
export declare function createAgentStdoutTextEmitter(options: AgentStdoutTextEmitterOptions): AgentStdoutTextEmitter;
export {};
