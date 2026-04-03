import { resolve, dirname } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { WatchTree } from "./watch";
import {
  buildOverlayEffect,
  cleanupGenerationsEffect,
  resolveOverlayEntry,
} from "./overlay";
import type { SmithersWorkflow } from "../SmithersWorkflow";
import type { HotReloadOptions } from "../RunOptions";
import { Metric } from "effect";
import { fromPromise } from "../effect/interop";
import { logInfo, logWarning } from "../effect/logging";
import { runPromise } from "../effect/runtime";
import { hotReloads, hotReloadFailures, hotReloadDuration } from "../effect/metrics";
import { SmithersError } from "../utils/errors";

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
    await runPromise(this.initEffect());
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
    return runPromise(this.waitEffect());
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
    return runPromise(this.reloadEffect(changedFiles));
  }

  initEffect() {
    return Effect.gen(this, function* () {
      yield* fromPromise("create hot reload output dir", () =>
        mkdir(this.outDir, { recursive: true }),
      );
      yield* this.watcher.startEffect();
      yield* Effect.sync(() => {
        logInfo("initialized hot workflow controller", {
          entryPath: this.entryPath,
          hotRoot: this.hotRoot,
          outDir: this.outDir,
        }, "hot:controller");
      });
    }).pipe(
      Effect.annotateLogs({
        entryPath: this.entryPath,
        hotRoot: this.hotRoot,
        outDir: this.outDir,
      }),
      Effect.withLogSpan("hot:init"),
    );
  }

  waitEffect() {
    return this.watcher.waitEffect().pipe(
      Effect.annotateLogs({
        entryPath: this.entryPath,
        generation: this.generation,
      }),
      Effect.withLogSpan("hot:wait"),
    );
  }

  reloadEffect(changedFiles: string[]) {
    this.generation += 1;
    const gen = this.generation;
    const entryPath = this.entryPath;
    const hotRoot = this.hotRoot;
    const outDir = this.outDir;
    const maxGenerations = this.maxGenerations;

    return Effect.gen(this, function* () {
      const reloadStart = performance.now();
      const genDir = yield* buildOverlayEffect(hotRoot, outDir, gen);
      const overlayEntry = resolveOverlayEntry(
        entryPath,
        hotRoot,
        genDir,
      );
      const overlayUrl = pathToFileURL(overlayEntry).href;

      const mod = yield* Effect.either(
        fromPromise("import hot workflow generation", () => import(overlayUrl)),
      );
      if (mod._tag === "Left") {
        logWarning("hot workflow import failed", {
          entryPath,
          generation: gen,
          changedFileCount: changedFiles.length,
          error:
            mod.left instanceof Error ? mod.left.message : String(mod.left),
        }, "hot:reload");
        return { type: "failed", generation: gen, changedFiles, error: mod.left } satisfies HotReloadEvent;
      }

      const workflow = mod.right.default as SmithersWorkflow<any> | undefined;
      if (!workflow) {
        return {
          type: "failed",
          generation: gen,
          changedFiles,
          error: new SmithersError(
            "HOT_RELOAD_INVALID_MODULE",
            "Reloaded module does not export default",
            { changedFiles, entryPath, generation: gen },
          ),
        } satisfies HotReloadEvent;
      }
      if (typeof workflow.build !== "function") {
        return {
          type: "failed",
          generation: gen,
          changedFiles,
          error: new SmithersError(
            "HOT_RELOAD_INVALID_MODULE",
            "Reloaded module default does not have a build function",
            { changedFiles, entryPath, generation: gen },
          ),
        } satisfies HotReloadEvent;
      }

      yield* cleanupGenerationsEffect(outDir, maxGenerations);
      yield* Metric.increment(hotReloads);
      yield* Metric.update(hotReloadDuration, performance.now() - reloadStart);
      logInfo("reloaded hot workflow generation", {
        entryPath,
        generation: gen,
        changedFileCount: changedFiles.length,
      }, "hot:reload");
      return {
        type: "reloaded",
        generation: gen,
        changedFiles,
        newBuild: workflow.build,
      } satisfies HotReloadEvent;
    }).pipe(
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          yield* Metric.increment(hotReloadFailures);
          if (err instanceof Error && err.message?.includes("Schema change detected")) {
            logWarning("hot workflow reload marked unsafe", {
              entryPath,
              generation: gen,
              changedFileCount: changedFiles.length,
              reason: err.message,
            }, "hot:reload");
            return {
              type: "unsafe",
              generation: gen,
              changedFiles,
              reason: err.message,
            } satisfies HotReloadEvent;
          }
          logWarning("hot workflow reload failed", {
            entryPath,
            generation: gen,
            changedFileCount: changedFiles.length,
            error: err instanceof Error ? err.message : String(err),
          }, "hot:reload");
          return {
            type: "failed",
            generation: gen,
            changedFiles,
            error: err,
          } satisfies HotReloadEvent;
        }),
      ),
      Effect.annotateLogs({
        entryPath,
        hotRoot,
        generation: gen,
      }),
      Effect.withLogSpan("hot:reload"),
    );
  }

  /** Stop watchers and clean up overlay directory. */
  async close(): Promise<void> {
    await runPromise(this.closeEffect());
  }

  closeEffect() {
    return Effect.gen(this, function* () {
      if (this.closed) return;
      this.closed = true;
      this.watcher.close();
      yield* Effect.either(
        fromPromise("remove hot reload output dir", () =>
          rm(this.outDir, { recursive: true, force: true }),
        ),
      );
      logInfo("closed hot workflow controller", {
        entryPath: this.entryPath,
        outDir: this.outDir,
        generation: this.generation,
      }, "hot:controller");
    }).pipe(
      Effect.annotateLogs({
        entryPath: this.entryPath,
        outDir: this.outDir,
        generation: this.generation,
      }),
      Effect.withLogSpan("hot:close"),
    );
  }
}
