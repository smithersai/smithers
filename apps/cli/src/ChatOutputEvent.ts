export type ChatOutputEvent = {
    seq: number;
    timestampMs: number;
    type: string;
    payloadJson: string;
};
