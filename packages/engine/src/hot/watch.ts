import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { Effect } from "effect";
import { fromPromise } from "@smithers/driver/interop";
import { logDebug, logInfo } from "@smithers/observability/logging";

const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  ".jj",
  ".smithers",
];

export type WatchTreeOptions = {
  /** Patterns to ignore (directory basenames) */
  ignore?: string[];
  /** Debounce interval in ms (default: 100) */
  debounceMs?: number;
};

export class WatchTree {
  private watchers: FSWatcher[] = [];
  private rootDir: string;
  private ignore: string[];
  private debounceMs: number;
  private changedFiles = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private waitResolve: ((files: string[]) => void) | null = null;
  private closed = false;

  constructor(rootDir: string, opts?: WatchTreeOptions) {
    this.rootDir = resolve(rootDir);
    this.ignore = opts?.ignore ?? DEFAULT_IGNORE;
    this.debounceMs = opts?.debounceMs ?? 100;
  }

  /** Start watching. Call once. */
  async start(): Promise<void> {
    await Effect.runPromise(this.startEffect());
  }

  /**
   * Returns a promise that resolves with changed file paths
   * the next time file changes are detected (after debounce).
   * Can be called repeatedly.
   */
  wait(): Promise<string[]> {
    // If there are already buffered changes, resolve immediately
    if (this.changedFiles.size > 0) {
      const files = [...this.changedFiles];
      this.changedFiles.clear();
      return Promise.resolve(files);
    }
    return runPromise(this.waitEffect());
  }

  /** Stop all watchers and clean up. */
  close(): void {
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const w of this.watchers) {
      try { w.close(); } catch {}
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
    return fromPromise("start hot watch tree", () => this.watchDir(this.rootDir)).pipe(
      Effect.annotateLogs({
        rootDir: this.rootDir,
        debounceMs: this.debounceMs,
      }),
      Effect.withLogSpan("hot:watch-start"),
    );
  }

  waitEffect() {
    return Effect.async<string[]>((resume) => {
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
    }).pipe(
      Effect.annotateLogs({
        rootDir: this.rootDir,
      }),
      Effect.withLogSpan("hot:watch-wait"),
    );
  }

  private shouldIgnore(name: string): boolean {
    return this.ignore.includes(name) || name.startsWith(".");
  }

  private async watchDir(dir: string): Promise<void> {
    if (this.closed) return;

    const baseName = dir.split("/").pop() ?? "";
    if (baseName && this.shouldIgnore(baseName) && dir !== this.rootDir) return;

    try {
      const watcher = watch(dir, (eventType, filename) => {
        if (!filename || this.closed) return;
        // Ignore hidden files and ignored dirs
        const parts = filename.split("/");
        if (parts.some((p) => this.shouldIgnore(p))) return;

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
    } catch {
      // Directory may have been deleted; ignore
    }
  }

  private onFileChange(filePath: string): void {
    this.changedFiles.add(filePath);

    // Debounce: reset timer on each change
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    if (this.changedFiles.size === 0) return;
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
