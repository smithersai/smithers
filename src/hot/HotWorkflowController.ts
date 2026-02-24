import { resolve, dirname } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { WatchTree } from "./watch";
import { buildOverlay, cleanupGenerations, resolveOverlayEntry } from "./overlay";
import type { SmithersWorkflow } from "../SmithersWorkflow";
import type { HotReloadOptions } from "../RunOptions";

export type HotReloadEvent =
  | { type: "reloaded"; generation: number; changedFiles: string[]; newBuild: SmithersWorkflow<any>["build"] }
  | { type: "failed"; generation: number; changedFiles: string[]; error: unknown }
  | { type: "unsafe"; generation: number; changedFiles: string[]; reason: string };

const DEFAULT_MAX_GENERATIONS = 3;
const DEFAULT_DEBOUNCE_MS = 100;

export class HotWorkflowController {
  private entryPath: string;
  private hotRoot: string;
  private outDir: string;
  private maxGenerations: number;
  private watcher: WatchTree;
  private generation = 0;
  private closed = false;

  constructor(entryPath: string, opts?: HotReloadOptions) {
    this.entryPath = resolve(entryPath);
    this.hotRoot = opts?.rootDir
      ? resolve(opts.rootDir)
      : dirname(this.entryPath);
    this.outDir = opts?.outDir
      ? resolve(opts.outDir)
      : resolve(this.hotRoot, ".smithers", "hmr");
    this.maxGenerations = opts?.maxGenerations ?? DEFAULT_MAX_GENERATIONS;
    this.watcher = new WatchTree(this.hotRoot, {
      debounceMs: opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    });
  }

  /** Initialize: start file watchers. Call once before using wait/reload. */
  async init(): Promise<void> {
    await mkdir(this.outDir, { recursive: true });
    await this.watcher.start();
  }

  /** Current generation number. */
  get gen(): number {
    return this.generation;
  }

  /**
   * Wait for the next file change event.
   * Returns the list of changed file paths.
   * Use this in Promise.race with inflight tasks to wake the engine loop.
   */
  async wait(): Promise<string[]> {
    return this.watcher.wait();
  }

  /**
   * Perform a hot reload:
   * 1. Build a new generation overlay
   * 2. Import the workflow module from the overlay
   * 3. Validate the module
   * 4. Return the result (reloaded, failed, or unsafe)
   *
   * The caller is responsible for swapping workflow.build on success.
   */
  async reload(changedFiles: string[]): Promise<HotReloadEvent> {
    this.generation += 1;
    const gen = this.generation;

    try {
      // 1. Build overlay
      const genDir = await buildOverlay(this.hotRoot, this.outDir, gen);

      // 2. Resolve entry path in overlay
      const overlayEntry = resolveOverlayEntry(this.entryPath, this.hotRoot, genDir);
      const overlayUrl = pathToFileURL(overlayEntry).href;

      // 3. Import fresh module
      let mod: any;
      try {
        mod = await import(overlayUrl);
      } catch (err: any) {
        return { type: "failed", generation: gen, changedFiles, error: err };
      }

      // 4. Validate module shape
      const workflow = mod.default as SmithersWorkflow<any> | undefined;
      if (!workflow) {
        return {
          type: "failed",
          generation: gen,
          changedFiles,
          error: new Error("Reloaded module does not export default"),
        };
      }
      if (typeof workflow.build !== "function") {
        return {
          type: "failed",
          generation: gen,
          changedFiles,
          error: new Error("Reloaded module default does not have a build function"),
        };
      }

      // 5. Cleanup old generations
      await cleanupGenerations(this.outDir, this.maxGenerations);

      // 6. Return success with the new build function
      return {
        type: "reloaded",
        generation: gen,
        changedFiles,
        newBuild: workflow.build,
      };
    } catch (err: any) {
      if (err?.message?.includes("Schema change detected")) {
        return {
          type: "unsafe",
          generation: gen,
          changedFiles,
          reason: err.message,
        };
      }
      return { type: "failed", generation: gen, changedFiles, error: err };
    }
  }

  /** Stop watchers and clean up overlay directory. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watcher.close();
    try {
      await rm(this.outDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
