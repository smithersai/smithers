import type { Schema } from "effect";

export type WaitForEventDurableDeferredResolution = Schema.Schema.Type<
	Schema.Struct<{
		signalName: typeof Schema.String;
		correlationId: Schema.NullOr<typeof Schema.String>;
		payloadJson: typeof Schema.String;
		seq: typeof Schema.Number;
		receivedAtMs: typeof Schema.Number;
	}>
>;
