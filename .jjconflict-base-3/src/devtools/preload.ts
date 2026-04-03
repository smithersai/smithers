/**
 * Preload script that installs the React DevTools global hook before
 * any React code runs. Use this as a Bun preload:
 *
 *   bun --preload ./src/devtools/preload.ts run myworkflow.tsx
 *
 * Or in bunfig.toml:
 *   preload = ["./src/devtools/preload.ts"]
 */
import { installRDTHook } from "bippy";

installRDTHook();
