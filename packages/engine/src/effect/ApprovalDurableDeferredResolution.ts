import type { Schema } from "effect";

export type ApprovalDurableDeferredResolution = Schema.Schema.Type<
	Schema.Struct<{
		approved: typeof Schema.Boolean;
		note: Schema.NullOr<typeof Schema.String>;
		decidedBy: Schema.NullOr<typeof Schema.String>;
		decisionJson: Schema.NullOr<typeof Schema.String>;
		autoApproved: typeof Schema.Boolean;
	}>
>;
