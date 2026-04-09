import { runPromise } from "../effect/runtime";
import {
  createSmithersIdeService,
  createSmithersIdeLayer,
  detectSmithersIdeAvailabilityEffect,
  type SmithersIdeAvailability,
  type SmithersIdeServiceConfig,
  SmithersIdeService,
} from "./SmithersIdeService";
import { createSmithersIdeCli, SMITHERS_IDE_TOOL_NAMES } from "./tools";

export {
  askUser,
  createSmithersIdeLayer,
  createSmithersIdeService,
  detectSmithersIdeAvailabilityEffect,
  openDiff,
  openFile,
  openWebview,
  runTerminal,
  showOverlay,
  SmithersIdeService,
  type SmithersIdeAskUserResult,
  type SmithersIdeAvailability,
  type SmithersIdeCommandBaseResult,
  type SmithersIdeOpenDiffResult,
  type SmithersIdeOpenFileResult,
  type SmithersIdeOpenWebviewResult,
  type SmithersIdeOverlayOptions,
  type SmithersIdeOverlayResult,
  type SmithersIdeOverlayType,
  type SmithersIdeResolvedConfig,
  type SmithersIdeRunTerminalResult,
  type SmithersIdeServiceApi,
  type SmithersIdeServiceConfig,
} from "./SmithersIdeService";

export {
  createSmithersIdeCli,
  SMITHERS_IDE_TOOL_NAMES,
} from "./tools";

export function isSmithersIdeAvailable(
  config: SmithersIdeServiceConfig = {},
) {
  return getSmithersIdeAvailability(config).then((availability) => availability.available);
}

export async function getSmithersIdeAvailability(
  config: SmithersIdeServiceConfig = {},
): Promise<SmithersIdeAvailability> {
  return runPromise(detectSmithersIdeAvailabilityEffect(config));
}

export async function createAvailableSmithersIdeCli(
  config: SmithersIdeServiceConfig = {},
) {
  const availability = await getSmithersIdeAvailability(config);
  return availability.available ? createSmithersIdeCli(config) : null;
}
