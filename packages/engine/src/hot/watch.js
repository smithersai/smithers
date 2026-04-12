import { watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { Effect } from "effect";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { logDebug, logInfo } from "@smithers/observability/logging";
/** @typedef {import("./watch.ts").WatchTreeOptions} WatchTreeOptions */

const DEFAULT_IGNORE = [
    "node_modules",
    ".git",
    ".jj",
    ".smithers",
];
export class WatchTree {
    watchers = [];
    rootDir;
    ignore;
    debounceMs;
    changedFiles = new Set();
    debounceTimer = null;
    waitResolve = null;
    closed = false;
    /**
   * @param {string} rootDir
   * @param {WatchTreeOptions} [opts]
   */
    constructor(rootDir, opts) {
        this.rootDir = resolve(rootDir);
        this.ignore = opts?.ignore ?? DEFAULT_IGNORE;
        this.debounceMs = opts?.debounceMs ?? 100;
    }
    /** Start watching. Call once. */
    async start() {
        await Effect.runPromise(this.startEffect());
    }
    /**
     * Returns a promise that resolves with changed file paths
     * the next time file changes are detected (after debounce).
     * Can be called repeatedly.
     */
    wait() {
        // If there are already buffered changes, resolve immediately
        if (this.changedFiles.size > 0) {
            const files = [...this.changedFiles];
            this.changedFiles.clear();
            return Promise.resolve(files);
        }
        return Effect.runPromise(this.waitEffect());
    }
    /** Stop all watchers and clean up. */
    close() {
        this.closed = true;
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        for (const w of this.watchers) {
            try {
                w.close();
            }
            catch { }
        }
        this.watchers = [];
        // Resolve any pending wait with empty array
        if (this.waitResolve) {
            this.waitResolve([]);
            this.waitResolve = null;
        }
        logInfo("closed hot watch tree", {
            rootDir: this.rootDir,
        }, "hot:watch");
    }
    startEffect() {
        return Effect.tryPromise({
            try: () => this.watchDir(this.rootDir),
            catch: (cause) => toSmithersError(cause, "start hot watch tree"),
        }).pipe(Effect.annotateLogs({
            rootDir: this.rootDir,
            debounceMs: this.debounceMs,
        }), Effect.withLogSpan("hot:watch-start"));
    }
    waitEffect() {
        return Effect.async((resume) => {
            if (this.changedFiles.size > 0) {
                const files = [...this.changedFiles];
                this.changedFiles.clear();
                resume(Effect.succeed(files));
                return;
            }
            this.waitResolve = (files) => {
                resume(Effect.succeed(files));
            };
            return Effect.sync(() => {
                if (this.waitResolve) {
                    this.waitResolve = null;
                }
            });
        }).pipe(Effect.annotateLogs({
            rootDir: this.rootDir,
        }), Effect.withLogSpan("hot:watch-wait"));
    }
    /**
   * @param {string} name
   * @returns {boolean}
   */
    shouldIgnore(name) {
        return this.ignore.includes(name) || name.startsWith(".");
    }
    /**
   * @param {string} dir
   * @returns {Promise<void>}
   */
    async watchDir(dir) {
        if (this.closed)
            return;
        const baseName = dir.split("/").pop() ?? "";
        if (baseName && this.shouldIgnore(baseName) && dir !== this.rootDir)
            return;
        try {
            const watcher = watch(dir, (eventType, filename) => {
                if (!filename || this.closed)
                    return;
                // Ignore hidden files and ignored dirs
                const parts = filename.split("/");
                if (parts.some((p) => this.shouldIgnore(p)))
                    return;
                const fullPath = resolve(dir, filename);
                logDebug("hot watch tree observed file change", {
                    rootDir: this.rootDir,
                    eventType,
                    fullPath,
                }, "hot:watch");
                this.onFileChange(fullPath);
            });
            this.watchers.push(watcher);
            // Recursively watch subdirectories
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !this.shouldIgnore(entry.name)) {
                    await this.watchDir(resolve(dir, entry.name));
                }
            }
        }
        catch {
            // Directory may have been deleted; ignore
        }
    }
    /**
   * @param {string} filePath
   */
    onFileChange(filePath) {
        this.changedFiles.add(filePath);
        // Debounce: reset timer on each change
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.flush();
        }, this.debounceMs);
    }
    flush() {
        if (this.changedFiles.size === 0)
            return;
        const files = [...this.changedFiles];
        this.changedFiles.clear();
        logInfo("flushing hot watch changes", {
            rootDir: this.rootDir,
            changedFileCount: files.length,
            changedFiles: files.join(","),
        }, "hot:watch");
        if (this.waitResolve) {
            this.waitResolve(files);
            this.waitResolve = null;
        }
    }
}
