export type ParsedNodeOutputEvent = {
    seq: number;
    timestampMs: number;
    nodeId: string;
    iteration: number;
    attempt: number;
    stream: "stdout" | "stderr";
    text: string;
};
