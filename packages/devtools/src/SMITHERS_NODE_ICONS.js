/** @typedef {import("./SmithersNodeType.ts").SmithersNodeType} SmithersNodeType */

/** @type {Record<SmithersNodeType, string>} */
export const SMITHERS_NODE_ICONS = {
    workflow: "📋",
    task: "⚡",
    sequence: "➡️",
    parallel: "⚡",
    "merge-queue": "🔀",
    branch: "🌿",
    loop: "🔁",
    worktree: "🌳",
    approval: "✋",
    timer: "⏱️",
    subflow: "🔗",
    "wait-for-event": "📡",
    saga: "🔄",
    "try-catch": "🛡️",
    fragment: "📦",
    unknown: "❓",
};
