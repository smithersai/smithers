// @smithers-type-exports-begin
/** @typedef {import("./SmithersIdeAskUserResult.ts").SmithersIdeAskUserResult} SmithersIdeAskUserResult */
/** @typedef {import("./SmithersIdeCommandBaseResult.ts").SmithersIdeCommandBaseResult} SmithersIdeCommandBaseResult */
/** @typedef {import("./SmithersIdeOpenDiffResult.ts").SmithersIdeOpenDiffResult} SmithersIdeOpenDiffResult */
/** @typedef {import("./SmithersIdeOpenFileResult.ts").SmithersIdeOpenFileResult} SmithersIdeOpenFileResult */
/** @typedef {import("./SmithersIdeOpenWebviewResult.ts").SmithersIdeOpenWebviewResult} SmithersIdeOpenWebviewResult */
/** @typedef {import("./SmithersIdeOverlayOptions.ts").SmithersIdeOverlayOptions} SmithersIdeOverlayOptions */
/** @typedef {import("./SmithersIdeOverlayResult.ts").SmithersIdeOverlayResult} SmithersIdeOverlayResult */
/** @typedef {import("./SmithersIdeOverlayType.ts").SmithersIdeOverlayType} SmithersIdeOverlayType */
/** @typedef {import("./SmithersIdeResolvedConfig.ts").SmithersIdeResolvedConfig} SmithersIdeResolvedConfig */
/** @typedef {import("./SmithersIdeRunTerminalResult.ts").SmithersIdeRunTerminalResult} SmithersIdeRunTerminalResult */
/** @typedef {import("./SmithersIdeServiceApi.ts").SmithersIdeServiceApi} SmithersIdeServiceApi */
/** @typedef {import("./SmithersIdeAvailability.ts").SmithersIdeAvailability} SmithersIdeAvailability */
/** @typedef {import("./SmithersIdeServiceConfig.ts").SmithersIdeServiceConfig} SmithersIdeServiceConfig */
// @smithers-type-exports-end

import { Effect } from "effect";
import { createSmithersIdeService, createSmithersIdeLayer, detectSmithersIdeAvailabilityEffect, SmithersIdeService, } from "./SmithersIdeService.js";
import { createSmithersIdeCli, SMITHERS_IDE_TOOL_NAMES } from "./tools.js";

export { askUser, createSmithersIdeLayer, createSmithersIdeService, detectSmithersIdeAvailabilityEffect, openDiff, openFile, openWebview, runTerminal, showOverlay, SmithersIdeService, } from "./SmithersIdeService.js";
export { createSmithersIdeCli, SMITHERS_IDE_TOOL_NAMES, } from "./tools.js";
/**
 * @param {SmithersIdeServiceConfig} [config]
 * @returns {Promise<boolean>}
 */
export function isSmithersIdeAvailable(config = {}) {
    return getSmithersIdeAvailability(config).then((availability) => availability.available);
}
/**
 * @param {SmithersIdeServiceConfig} [config]
 * @returns {Promise<SmithersIdeAvailability>}
 */
export async function getSmithersIdeAvailability(config = {}) {
    return Effect.runPromise(detectSmithersIdeAvailabilityEffect(config));
}
/**
 * @param {SmithersIdeServiceConfig} [config]
 * @returns {Promise<ReturnType<typeof createSmithersIdeCli> | null>}
 */
export async function createAvailableSmithersIdeCli(config = {}) {
    const availability = await getSmithersIdeAvailability(config);
    return availability.available ? createSmithersIdeCli(config) : null;
}
