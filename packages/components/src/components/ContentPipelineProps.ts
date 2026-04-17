import type React from "react";
import type { ContentPipelineStage } from "./ContentPipelineStage.ts";

export type ContentPipelineProps = {
	id?: string;
	/** Pipeline stages executed in order. Each stage receives the previous stage's output. */
	stages: ContentPipelineStage[];
	/** Skip the entire pipeline. */
	skipIf?: boolean;
	/** Initial prompt/content for the first stage (string or ReactNode). */
	children: string | React.ReactNode;
};
