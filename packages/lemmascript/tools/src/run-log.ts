/**
 * Run log: record each Dafny `lsc check` / `lsc regen` run in
 * `.lemmascript/runs.jsonl` (a run where Dafny is not installed records
 * nothing), with a snapshot of the source, so that a later
 * report can tell which failures were fixed and whether the fix changed the
 * program or only the proof, and read the records back for that report.
 * Logging must never change lsc's output or exit code, so every filesystem
 * step is best-effort and swallows its own errors.
 */

import { createHash, randomUUID } from "crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { findUp } from "./config.js";

export const RUN_LOG_SCHEMA_VERSION = 1;

export interface MemberResults {
  passed: string[];
  failed: string[];
}

/**
 * Where a run stopped: `diff` (additions-only check failed, Dafny never ran),
 * `conflict` (regen merge conflict), `resolve` (Dafny produced no member results),
 * `verify` (Dafny reported failures), or `ok`.
 */
export type RunStage = "ok" | "verify" | "resolve" | "diff" | "conflict";

export interface VerifyRecord {
  v: number;
  type: "verify";
  id: string;
  ts: string;
  cmd: "check" | "regen";
  file: string;
  stage: RunStage;
  exit: number;
  partial: boolean;
  failed: string[];
  passed: string[];
  tsHash: string | null;
  dfyHash: string | null;
  lsc: string | null;
}

export interface RunLogInit {
  logDir: string;
  cmd: "check" | "regen";
  sourcePath: string;
  extraFlags?: string;
  lscVersion: string | null;
}

/**
 * Combine the `run-log` option with the `LSC_RUN_LOG` value lsc.ts read:
 * `false` turns logging off for one run; `true` or unset leaves it to the
 * config. Like lemmascript.json, any other value is an error.
 */
export function runLogEnabled(option: boolean, value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "true") return option;
  if (value === "false") return false;
  throw new Error(`LSC_RUN_LOG must be true or false (got ${JSON.stringify(value)})`);
}

/** The selected lemmascript.json's directory, else LemmaScript-files.txt's, else the source's git root, else cwd. */
export function resolveLogDir(sourcePath: string, configFile: string | null): string {
  if (configFile) return path.dirname(path.resolve(configFile));
  const manifest = findUp("LemmaScript-files.txt", sourcePath);
  if (manifest) return path.dirname(manifest);
  const git = findUp(".git", sourcePath);
  return git ? path.dirname(git) : process.cwd();
}

/** A filtered Dafny run verifies only some members, so absences mean nothing. */
export function isPartialRun(extraFlags: string | undefined): boolean {
  return /--filter-(symbol|position)\b/.test(extraFlags ?? "");
}

/**
 * Parse Dafny's `--log-format text` file. Each member gets one entry per
 * check (`correctness`, `well-formedness`); it passes only if every check's
 * outcome is `Correct`.
 */
export function parseTextLog(text: string): MemberResults {
  const seen = new Set<string>();
  const failed = new Set<string>();
  for (const m of text.matchAll(/^Results for (.+?) \([a-z-]+\)\r?\n\s+Overall outcome: (\S+)/gm)) {
    seen.add(m[1]);
    if (m[2] !== "Correct") failed.add(m[1]);
  }
  return {
    passed: [...seen].filter(name => !failed.has(name)).sort(),
    failed: [...failed].sort(),
  };
}

/**
 * Whether a parsed log line is a verify record of this schema with every field
 * reading it relies on, so a hand-edited line is skipped rather than misread.
 */
function isVerifyRecord(r: any): r is VerifyRecord {
  const names = (x: unknown) => Array.isArray(x) && x.every(m => typeof m === "string");
  const hash = (x: unknown) => x === null || typeof x === "string";
  return r?.type === "verify" && r.v === RUN_LOG_SCHEMA_VERSION
    && typeof r.id === "string" && typeof r.file === "string"
    && typeof r.ts === "string" && !Number.isNaN(Date.parse(r.ts))
    && typeof r.partial === "boolean" && names(r.failed) && names(r.passed)
    && hash(r.tsHash) && hash(r.dfyHash);
}

/** First 12 hex characters of the SHA-256 of `text`. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function safely<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Create `<logDir>/.lemmascript/` with a `.gitignore` that ignores the whole directory. */
export function ensureLogDir(logDir: string): string {
  const dir = path.join(logDir, ".lemmascript");
  mkdirSync(path.join(dir, "blobs"), { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return dir;
}

/** Store the source as `blobs/<hash>.ts` unless that version is already there. */
export function snapshotSource(dir: string, text: string): string {
  const hash = hashText(text);
  const blob = path.join(dir, "blobs", `${hash}.ts`);
  if (!existsSync(blob)) writeFileSync(blob, text);
  return hash;
}

/**
 * The `verify` records in `<logDir>/.lemmascript/runs.jsonl`, in file order.
 * Skips lines that don't parse (such as a half-written last line), other
 * record types, other schema versions and records missing a field or
 * holding one of the wrong type; a missing log has no records.
 */
export function readRecords(logDir: string): VerifyRecord[] {
  const text = safely(() => readFileSync(path.join(logDir, ".lemmascript", "runs.jsonl"), "utf8")) ?? "";
  const records: VerifyRecord[] = [];
  for (const line of text.split("\n")) {
    const r = safely(() => JSON.parse(line));
    if (isVerifyRecord(r)) records.push(r);
  }
  return records;
}

/**
 * One verification run. `lsc.ts` creates it before generating and passes it to
 * the Dafny helpers; whichever helper sees how the run ended calls `finish`, or
 * `discard` when nothing was verified. Only the first of these calls counts.
 */
export class RunLog {
  private readonly dir: string | null;
  private readonly tsHash: string | null;
  private readonly startedAt = new Date().toISOString();
  private textLogDir: string | null = null;
  private done = false;

  constructor(private readonly init: RunLogInit) {
    this.dir = safely(() => ensureLogDir(init.logDir));
    this.tsHash = this.dir === null ? null
      : safely(() => snapshotSource(this.dir!, readFileSync(init.sourcePath, "utf8")));
  }

  /** Extra Dafny arguments that write member outcomes to a temporary text log. */
  dafnyArgs(): string[] {
    this.textLogDir = safely(() => mkdtempSync(path.join(tmpdir(), "lsc-run-log-")));
    return this.textLogDir === null ? [] : ["--log-format", `text;LogFileName=${this.textLogPath()}`];
  }

  /**
   * Member outcomes from Dafny's text log, or null when it names no members:
   * Dafny writes no file for a parse error and an empty one for a resolution error.
   */
  readResults(): MemberResults | null {
    if (this.textLogDir === null) return null;
    const results = safely(() => parseTextLog(readFileSync(this.textLogPath(), "utf8")));
    return results && results.passed.length + results.failed.length > 0 ? results : null;
  }

  /** Append this run's record. Never throws; only the first call writes. */
  finish(outcome: { stage: RunStage; exit: number; dfyPath: string; results?: MemberResults | null }): void {
    if (this.done) return;
    this.done = true;
    const dir = this.dir;
    if (dir !== null) {
      safely(() => {
        const results = outcome.results ?? null;
        const record: VerifyRecord = {
          v: RUN_LOG_SCHEMA_VERSION,
          type: "verify",
          id: randomUUID(),
          ts: this.startedAt,
          cmd: this.init.cmd,
          file: path.relative(this.init.logDir, this.init.sourcePath).split(path.sep).join("/"),
          stage: outcome.stage,
          exit: outcome.exit,
          partial: results === null || isPartialRun(this.init.extraFlags),
          failed: results?.failed ?? [],
          passed: results?.passed ?? [],
          tsHash: this.tsHash,
          dfyHash: safely(() => hashText(readFileSync(outcome.dfyPath, "utf8"))),
          lsc: this.init.lscVersion,
        };
        appendFileSync(path.join(dir, "runs.jsonl"), JSON.stringify(record) + "\n");
      });
    }
    this.removeTextLogDir();
  }

  /** End the run without a record, because nothing was verified (for example, no Dafny). */
  discard(): void {
    if (this.done) return;
    this.done = true;
    this.removeTextLogDir();
  }

  private textLogPath(): string {
    return path.join(this.textLogDir!, "verify.txt");
  }

  private removeTextLogDir(): void {
    if (this.textLogDir === null) return;
    const tmp = this.textLogDir;
    safely(() => rmSync(tmp, { recursive: true, force: true }));
  }
}
