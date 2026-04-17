import type { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { SmithersIdeResolvedConfig } from "./SmithersIdeResolvedConfig.ts";
import type { SmithersIdeAskUserResult } from "./SmithersIdeAskUserResult.ts";
import type { SmithersIdeAvailability } from "./SmithersIdeAvailability.ts";
import type { SmithersIdeOpenDiffResult } from "./SmithersIdeOpenDiffResult.ts";
import type { SmithersIdeOpenFileResult } from "./SmithersIdeOpenFileResult.ts";
import type { SmithersIdeOpenWebviewResult } from "./SmithersIdeOpenWebviewResult.ts";
import type { SmithersIdeOverlayOptions } from "./SmithersIdeOverlayOptions.ts";
import type { SmithersIdeOverlayResult } from "./SmithersIdeOverlayResult.ts";
import type { SmithersIdeOverlayType } from "./SmithersIdeOverlayType.ts";
import type { SmithersIdeRunTerminalResult } from "./SmithersIdeRunTerminalResult.ts";

export type SmithersIdeServiceApi = {
	readonly config: SmithersIdeResolvedConfig;
	readonly askUser: (prompt: string) => Effect.Effect<SmithersIdeAskUserResult, SmithersError>;
	readonly detectAvailability: () => Effect.Effect<SmithersIdeAvailability>;
	readonly openDiff: (content: string) => Effect.Effect<SmithersIdeOpenDiffResult, SmithersError>;
	readonly openFile: (
		path: string,
		line?: number,
		column?: number,
	) => Effect.Effect<SmithersIdeOpenFileResult, SmithersError>;
	readonly openWebview: (
		url: string,
	) => Effect.Effect<SmithersIdeOpenWebviewResult, SmithersError>;
	readonly runTerminal: (
		command: string,
		cwd?: string,
	) => Effect.Effect<SmithersIdeRunTerminalResult, SmithersError>;
	readonly showOverlay: (
		type: SmithersIdeOverlayType,
		options: SmithersIdeOverlayOptions,
	) => Effect.Effect<SmithersIdeOverlayResult, SmithersError>;
};
