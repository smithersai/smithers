// @smithers-type-exports-begin
/** @typedef {import("./HotWorkflowController.ts").HotReloadEvent} HotReloadEvent */
// @smithers-type-exports-end

import { resolve, dirname } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { WatchTree } from "./watch.js";
import { buildOverlayEffect, cleanupGenerationsEffect, resolveOverlayEntry, } from "./overlay.js";
import { Metric } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { logInfo, logWarning } from "@smithers/observability/logging";
import { hotReloads, hotReloadFailures, hotReloadDuration } from "@smithers/observability/metrics";
import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("@smithers/driver/RunOptions").HotReloadOptions} HotReloadOptions */

const DEFAULT_MAX_GENERATIONS = 3;
const DEFAULT_DEBOUNCE_MS = 100;
export class HotWorkflowController {
    entryPath;
    hotRoot;
    outDir;
    maxGenerations;
    watcher;
    generation = 0;
    closed = false;
    /**
   * @param {string} entryPath
   * @param {HotReloadOptions} [opts]
   */
    constructor(entryPath, opts) {
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
    async init() {
        await Effect.runPromise(this.initEffect());
    }
    /** Current generation number. */
    get gen() {
        return this.generation;
    }
    /**
     * Wait for the next file change event.
     * Returns the list of changed file paths.
     * Use this in Promise.race with inflight tasks to wake the engine loop.
     */
    async wait() {
        return Effect.runPromise(this.waitEffect());
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
    async reload(changedFiles) {
        return Effect.runPromise(this.reloadEffect(changedFiles));
    }
    initEffect() {
        return Effect.gen(this, function* () {
            yield* Effect.tryPromise({
                try: () => mkdir(this.outDir, { recursive: true }),
                catch: (cause) => toSmithersError(cause, "create hot reload output dir"),
            });
            yield* this.watcher.startEffect();
            yield* Effect.sync(() => {
                logInfo("initialized hot workflow controller", {
                    entryPath: this.entryPath,
                    hotRoot: this.hotRoot,
                    outDir: this.outDir,
                }, "hot:controller");
            });
        }).pipe(Effect.annotateLogs({
            entryPath: this.entryPath,
            hotRoot: this.hotRoot,
            outDir: this.outDir,
        }), Effect.withLogSpan("hot:init"));
    }
    waitEffect() {
        return this.watcher.waitEffect().pipe(Effect.annotateLogs({
            entryPath: this.entryPath,
            generation: this.generation,
        }), Effect.withLogSpan("hot:wait"));
    }
    /**
   * @param {string[]} changedFiles
   */
    reloadEffect(changedFiles) {
        this.generation += 1;
        const gen = this.generation;
        const entryPath = this.entryPath;
        const hotRoot = this.hotRoot;
        const outDir = this.outDir;
        const maxGenerations = this.maxGenerations;
        return Effect.gen(this, function* () {
            const reloadStart = performance.now();
            const genDir = yield* buildOverlayEffect(hotRoot, outDir, gen);
            const overlayEntry = resolveOverlayEntry(entryPath, hotRoot, genDir);
            const overlayUrl = pathToFileURL(overlayEntry).href;
            const mod = yield* Effect.either(Effect.tryPromise({
                try: () => import(overlayUrl),
                catch: (cause) => toSmithersError(cause, "import hot workflow generation"),
            }));
            if (mod._tag === "Left") {
                logWarning("hot workflow import failed", {
                    entryPath,
                    generation: gen,
                    changedFileCount: changedFiles.length,
                    error: mod.left instanceof Error ? mod.left.message : String(mod.left),
                }, "hot:reload");
                return { type: "failed", generation: gen, changedFiles, error: mod.left };
            }
            const workflow = mod.right.default;
            if (!workflow) {
                return {
                    type: "failed",
                    generation: gen,
                    changedFiles,
                    error: new SmithersError("HOT_RELOAD_INVALID_MODULE", "Reloaded module does not export default", { changedFiles, entryPath, generation: gen }),
                };
            }
            if (typeof workflow.build !== "function") {
                return {
                    type: "failed",
                    generation: gen,
                    changedFiles,
                    error: new SmithersError("HOT_RELOAD_INVALID_MODULE", "Reloaded module default does not have a build function", { changedFiles, entryPath, generation: gen }),
                };
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
            };
        }).pipe(Effect.catchAll((err) => Effect.gen(function* () {
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
                };
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
            };
        })), Effect.annotateLogs({
            entryPath,
            hotRoot,
            generation: gen,
        }), Effect.withLogSpan("hot:reload"));
    }
    /** Stop watchers and clean up overlay directory. */
    async close() {
        await Effect.runPromise(this.closeEffect());
    }
    closeEffect() {
        return Effect.gen(this, function* () {
            if (this.closed)
                return;
            this.closed = true;
            this.watcher.close();
            yield* Effect.either(Effect.tryPromise({
                try: () => rm(this.outDir, { recursive: true, force: true }),
                catch: (cause) => toSmithersError(cause, "remove hot reload output dir"),
            }));
            logInfo("closed hot workflow controller", {
                entryPath: this.entryPath,
                outDir: this.outDir,
                generation: this.generation,
            }, "hot:controller");
        }).pipe(Effect.annotateLogs({
            entryPath: this.entryPath,
            outDir: this.outDir,
            generation: this.generation,
        }), Effect.withLogSpan("hot:close"));
    }
}
