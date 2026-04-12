// @smithers-type-exports-begin
/** @typedef {import("./index.ts").HotReloadEvent} HotReloadEvent */
/** @typedef {import("./index.ts").OverlayOptions} OverlayOptions */
/** @typedef {import("./index.ts").WatchTreeOptions} WatchTreeOptions */
// @smithers-type-exports-end

export { WatchTree } from "./watch.js";
export { buildOverlay, cleanupGenerations, resolveOverlayEntry } from "./overlay.js";
export { HotWorkflowController } from "./HotWorkflowController.js";
