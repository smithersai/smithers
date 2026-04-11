import type { SmithersNodeType } from "./SmithersNodeType.ts";

export const SMITHERS_NODE_ICONS: Record<SmithersNodeType, string> = {
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
