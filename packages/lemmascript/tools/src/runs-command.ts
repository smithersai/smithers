/**
 * `lsc runs` — read the run log and report what verification caught.
 *
 * A catch is a failure that a later run fixed. Each run gives each Dafny
 * member a verdict; a streak of failures ending in a pass is one catch, a
 * streak ending with the member gone is dropped, and a streak still failing
 * at the end of the log is open. Members are then merged per TypeScript
 * function (lsc's generated helpers left out), and each catch is classified
 * by what changed between its first failing run and its passing run. A
 * source fix also gets the diff of its two `.ts` snapshots and a hint at
 * whether the code, the spec or only the proof changed. `runsReport` gathers
 * all of this as data (what `--json` prints) and `formatText` summarises it;
 * `runRuns` is the command `lsc.ts` calls.
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { DAFNY_HELPER_NAMES, ENSURES_LEMMA_SUFFIX } from "./dafny-emit.js";
import type { AnnotKind } from "./extract.js";
import { loadConfigOptions } from "./config.js";
import { readRecords, resolveLogDir, type VerifyRecord } from "./run-log.js";

/**
 * Whether each `//@` keyword the extractor parses states what a function
 * promises (spec) or only helps the proof along. Typed by the extractor's own
 * keyword list, so adding or removing a keyword there fails the typecheck
 * here until it is classified. Other `//@` lines (`assert`, `havoc`, …) count as proof.
 */
const ANNOTATION_ROLES: Record<AnnotKind, "spec" | "proof"> = {
  requires: "spec",
  ensures: "spec",
  contract: "spec",
  invariant: "proof",
  decreases: "proof",
  done_with: "proof",
  type: "proof",
};

/**
 * The shape of the hashes the run log writes. Hashes come from runs.jsonl,
 * which anyone can edit, so only this shape may become a path or a git argument.
 */
const SNAPSHOT_HASH = /^[0-9a-f]{12}$/;

/** What one run says about one member. */
export type Verdict = "fail" | "pass" | "unchecked" | "gone";

/**
 * What a fix changed between the first failing run and the passing run: the
 * TypeScript source, only the Dafny proof, or nothing at all.
 */
export type CatchKind = "source-fix" | "proof" | "flaky";

/**
 * A guess at what a source fix changed, from its `.ts` diff: the code (likely
 * an implementation bug), the spec (likely a spec bug), both, or only proof
 * scaffolding and comments (likely not a bug).
 */
export type ChangeHint = "code" | "spec" | "mixed" | "proof";

/** A member's failure streak, before members are grouped by TypeScript function. */
export interface MemberResult {
  file: string;
  member: string;
  status: "caught" | "open" | "dropped";
  /** The first failing run of the streak. */
  failedRun: VerifyRecord;
  /** The run that passed, for a catch. */
  fixedRun?: VerifyRecord;
  /** The complete run that no longer had the member, for a dropped failure. */
  droppedRun?: VerifyRecord;
}

/** Member results merged per TypeScript function; `failedRun` is the earliest member's. */
export interface FunctionResult {
  file: string;
  function: string;
  members: string[];
  status: MemberResult["status"];
  failedRun: VerifyRecord;
  fixedRun?: VerifyRecord;
  droppedRun?: VerifyRecord;
}

/** A failure in one TypeScript function that a later run fixed. Runs are named by id; times are UTC. */
export interface Catch {
  /** `<first failing run id>:<function>`, stable across reports of the same log. */
  id: string;
  file: string;
  function: string;
  members: string[];
  kind: CatchKind;
  failedAt: string;
  failedRun: string;
  fixedAt: string;
  fixedRun: string;
  /** Source fixes only; both null when a snapshot is missing. */
  evidence?: { hint: ChangeHint | null; diff: string | null };
}

/** A failure not fixed: still failing (open), or its function went away (dropped, with `droppedRun`). */
export interface Unfixed {
  file: string;
  function: string;
  members: string[];
  failedAt: string;
  failedRun: string;
  droppedRun?: string;
}

/** Everything `lsc runs` reports about one log; `lsc runs --json` prints it as is. */
export interface RunsReport {
  v: 1;
  /** Absolute path of runs.jsonl. */
  log: string;
  runs: number;
  files: number;
  from: string | null;
  to: string | null;
  counts: { catches: number; sourceFix: number; proof: number; flaky: number; open: number; dropped: number };
  catches: Catch[];
  open: Unfixed[];
  dropped: Unfixed[];
}

/**
 * A member missing from a partial run (filtered, or one Dafny never reached)
 * was not checked; missing from a complete run, it is gone.
 */
function verdict(run: VerifyRecord, member: string): Verdict {
  if (run.failed.includes(member)) return "fail";
  if (run.passed.includes(member)) return "pass";
  return run.partial ? "unchecked" : "gone";
}

/** Every member's failure streaks, file by file, in log order. */
export function memberResults(records: VerifyRecord[]): MemberResult[] {
  const byFile = new Map<string, VerifyRecord[]>();
  for (const r of records) {
    const runs = byFile.get(r.file);
    if (runs === undefined) byFile.set(r.file, [r]);
    else runs.push(r);
  }

  const results: MemberResult[] = [];
  for (const [file, runs] of byFile) {
    const members = new Set(runs.flatMap(r => [...r.failed, ...r.passed]));
    for (const member of members) {
      let failedRun: VerifyRecord | null = null;
      for (const run of runs) {
        const v = verdict(run, member);
        if (v === "fail") {
          if (failedRun === null) failedRun = run;
          continue;
        }
        if (failedRun === null || v === "unchecked") continue;
        results.push(v === "pass"
          ? { file, member, status: "caught", failedRun, fixedRun: run }
          : { file, member, status: "dropped", failedRun, droppedRun: run });
        failedRun = null;
      }
      if (failedRun !== null) results.push({ file, member, status: "open", failedRun });
    }
  }
  return results;
}

/**
 * The TypeScript function a Dafny member verifies: `foo_ensures` belongs to
 * `foo`, and any other member is its own function. Null for lsc's generated
 * helpers, which are not the user's code.
 */
export function functionOf(member: string): string | null {
  if (DAFNY_HELPER_NAMES.has(member)) return null;
  return member.endsWith(ENSURES_LEMMA_SUFFIX) ? member.slice(0, -ENSURES_LEMMA_SUFFIX.length) : member;
}

/** Order ISO timestamps oldest first. */
function byTime(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** When a member's failure ended (the fixing or dropping run's time), or null while it is still open. */
function endOf(r: MemberResult): string | null {
  return (r.fixedRun ?? r.droppedRun)?.ts ?? null;
}

/** Whether `a`'s failure ended after `b`'s: open is latest, and a fix beats a drop in the same run. */
function endsLater(a: MemberResult, b: MemberResult): boolean {
  const ea = endOf(a);
  const eb = endOf(b);
  if (eb === null) return false;
  if (ea === null) return true;
  if (ea !== eb) return ea > eb;
  return a.status === "caught" && b.status !== "caught";
}

/** One function's overlapping member failures as one result, ending the way `last` (the latest to end) did. */
function mergeSpan(fn: string, span: MemberResult[], last: MemberResult): FunctionResult {
  return {
    file: last.file, function: fn, members: [...new Set(span.map(r => r.member))].sort(),
    status: last.status, failedRun: span[0].failedRun, fixedRun: last.fixedRun, droppedRun: last.droppedRun,
  };
}

/**
 * Merge member results into one per TypeScript function. A function is failing
 * while any of its members is, so member failures that overlap (or where one
 * starts in the run that ends another) are one result: it starts at the earliest
 * failure and ends the way the last of them ended (still open, fixed or dropped).
 * Generated helpers are left out.
 */
export function groupByFunction(results: MemberResult[]): FunctionResult[] {
  const byFunction = new Map<string, { fn: string; results: MemberResult[] }>();
  for (const r of results) {
    const fn = functionOf(r.member);
    if (fn === null) continue;
    const key = `${r.file}\0${fn}`;
    const group = byFunction.get(key);
    if (group === undefined) byFunction.set(key, { fn, results: [r] });
    else group.results.push(r);
  }
  const merged: FunctionResult[] = [];
  for (const { fn, results: group } of byFunction.values()) {
    group.sort((a, b) => byTime(a.failedRun.ts, b.failedRun.ts));
    let span: MemberResult[] = [];
    let last: MemberResult | null = null;
    for (const r of group) {
      // A failure starting after the span's last one ended means the function passed in between.
      const end = last === null ? null : endOf(last);
      if (last !== null && end !== null && r.failedRun.ts > end) {
        merged.push(mergeSpan(fn, span, last));
        span = [];
        last = null;
      }
      span.push(r);
      if (last === null || endsLater(r, last)) last = r;
    }
    if (last !== null) merged.push(mergeSpan(fn, span, last));
  }
  return merged;
}

/** Compare the first failing run with the passing run: source first, then proof. */
export function classify(failed: VerifyRecord, fixed: VerifyRecord): CatchKind {
  if (failed.tsHash !== fixed.tsHash) return "source-fix";
  if (failed.dfyHash !== fixed.dfyHash) return "proof";
  return "flaky";
}

/** What one changed line of a `.ts` diff touches, or null for blanks and comments. */
function lineChange(text: string): "code" | "spec" | "proof" | null {
  const line = text.trim();
  if (line.startsWith("//@")) return ANNOTATION_ROLES[line.slice(3).trim().split(/\s/)[0] as AnnotKind] === "spec" ? "spec" : "proof";
  if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) return null;
  return "code";
}

/** Hint at what a source fix changed, from the `+`/`-` lines of its unified diff. */
export function changeHint(diff: string): ChangeHint {
  const changed = new Set<string>();
  // Only file headers are metadata. Inside a hunk, even a line beginning
  // with "---" is a deletion (for example, `--count;`).
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@ ")) inHunk = true;
    else if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
      const change = lineChange(line.slice(1));
      if (change !== null) changed.add(change);
    }
  }
  if (changed.has("code")) return changed.has("spec") ? "mixed" : "code";
  return changed.has("spec") ? "spec" : "proof";
}

/** A UTC timestamp's date (`2026-10-06`) and time (`14:13`) in `timeZone`, or the local zone when undefined. */
function localTime(ts: string, timeZone: string | undefined): { date: string; time: string } {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const part = Object.fromEntries(format.formatToParts(new Date(ts)).map(p => [p.type, p.value]));
  return { date: `${part.year}-${part.month}-${part.day}`, time: `${part.hour}:${part.minute}` };
}

/** `1 run`, `3 runs`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Rows as aligned columns, two spaces apart; a row's last cell is never padded. */
function columns(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i] ?? 0, row[i].length);
  }
  return rows.map(row => row.map((cell, i) => i < row.length - 1 ? cell.padEnd(widths[i]) : cell).join("  "));
}

/**
 * The human summary of a report: the log's span and counts, then one line per
 * catch, open and dropped failure. Times are shown in `timeZone` (the local
 * zone by default), with dates only when the log spans more than one day;
 * open and dropped failures always show the date they first failed.
 */
export function formatText(report: RunsReport, timeZone?: string): string {
  if (report.runs === 0 || report.from === null || report.to === null) return `No runs recorded yet in ${report.log}.`;
  const from = localTime(report.from, timeZone);
  const to = localTime(report.to, timeZone);
  const oneDay = from.date === to.date;
  const dated = (ts: string) => { const t = localTime(ts, timeZone); return `${t.date} ${t.time}`; };
  const when = (ts: string) => oneDay ? localTime(ts, timeZone).time : dated(ts);
  const c = report.counts;

  const lines = [
    `${count(report.runs, "run")}, ${count(report.files, "file")}, ${from.date} ${from.time} → ${oneDay ? to.time : `${to.date} ${to.time}`}`,
    "",
    `catches: ${c.catches}   (source-fix ${c.sourceFix}, proof ${c.proof}, flaky ${c.flaky})`,
    `open: ${c.open}   dropped: ${c.dropped}`,
  ];
  const rows = [
    ...report.catches.map(k => [
      k.kind, k.file, k.function, `failed ${when(k.failedAt)}, fixed ${when(k.fixedAt)}`,
      ...(k.evidence?.hint ? [`hint: ${k.evidence.hint}`] : []),
    ]),
    ...report.open.map(o => ["open", o.file, o.function, `failed ${dated(o.failedAt)}`]),
    ...report.dropped.map(d => ["dropped", d.file, d.function, `failed ${dated(d.failedAt)}`]),
  ];
  if (rows.length > 0) lines.push("", ...columns(rows));
  return lines.join("\n");
}

/**
 * The unified diff between two `.ts` snapshots in `<logDir>/.lemmascript/blobs/`,
 * or null when either is missing, a hash isn't a snapshot hash, or git can't
 * compare them.
 */
export function snapshotDiff(logDir: string, fromHash: string | null, toHash: string | null): string | null {
  if (fromHash === null || toHash === null || !SNAPSHOT_HASH.test(fromHash) || !SNAPSHOT_HASH.test(toHash)) return null;
  const blobs = path.join(logDir, ".lemmascript", "blobs");
  const from = `${fromHash}.ts`;
  const to = `${toHash}.ts`;
  if (!existsSync(path.join(blobs, from)) || !existsSync(path.join(blobs, to))) return null;
  try {
    // Run inside blobs/ so the diff headers name the snapshots, not the machine's paths.
    return execFileSync(
      "git",
      ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--text", "--", from, to],
      { cwd: blobs, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e: any) {
    // `git diff --no-index` exits 1 when the files differ; anything else (another
    // exit code, or no status because git was killed or never ran) is a failed comparison.
    const stdout = typeof e?.stdout === "string" ? e.stdout : "";
    return e?.status === 1 && stdout.startsWith("diff --git ") ? stdout : null;
  }
}

/** A caught function result as a catch, with diff evidence when the source changed. */
function toCatch(logDir: string, r: FunctionResult): Catch {
  const fixedRun = r.fixedRun!;
  const kind = classify(r.failedRun, fixedRun);
  const result: Catch = {
    id: `${r.failedRun.id}:${r.function}`, file: r.file, function: r.function, members: r.members, kind,
    failedAt: r.failedRun.ts, failedRun: r.failedRun.id, fixedAt: fixedRun.ts, fixedRun: fixedRun.id,
  };
  if (kind === "source-fix") {
    const diff = snapshotDiff(logDir, r.failedRun.tsHash, fixedRun.tsHash);
    result.evidence = { hint: diff === null ? null : changeHint(diff), diff };
  }
  return result;
}

/** An open or dropped function result, named by run ids. */
function toUnfixed(r: FunctionResult): Unfixed {
  return {
    file: r.file, function: r.function, members: r.members, failedAt: r.failedRun.ts, failedRun: r.failedRun.id,
    ...(r.droppedRun ? { droppedRun: r.droppedRun.id } : {}),
  };
}

/**
 * Read `<logDir>/.lemmascript/runs.jsonl` and report its catches (ordered by
 * fix time) and its open and dropped failures (ordered by failure time).
 */
export function runsReport(logDir: string): RunsReport {
  const records = readRecords(logDir);
  const results = groupByFunction(memberResults(records));
  const catches = results.filter(r => r.status === "caught").map(r => toCatch(logDir, r))
    .sort((a, b) => byTime(a.fixedAt, b.fixedAt));
  const unfixed = (status: FunctionResult["status"]) => results.filter(r => r.status === status).map(toUnfixed)
    .sort((a, b) => byTime(a.failedAt, b.failedAt));
  const open = unfixed("open");
  const dropped = unfixed("dropped");
  const times = records.map(r => r.ts).sort(byTime);
  return {
    v: 1,
    log: path.join(path.resolve(logDir), ".lemmascript", "runs.jsonl"),
    runs: records.length,
    files: new Set(records.map(r => r.file)).size,
    from: times[0] ?? null,
    to: times[times.length - 1] ?? null,
    counts: {
      catches: catches.length,
      sourceFix: catches.filter(c => c.kind === "source-fix").length,
      proof: catches.filter(c => c.kind === "proof").length,
      flaky: catches.filter(c => c.kind === "flaky").length,
      open: open.length,
      dropped: dropped.length,
    },
    catches, open, dropped,
  };
}

/** Whether `git` can be run, which snapshot diffs need. */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * `lsc runs [--json] [--config=<path>]`: report the log that `lsc check` and
 * `lsc regen` record to from the current directory. Recording settings don't
 * apply; a log that exists is always read.
 */
export function runRuns(args: string[]): void {
  let json = false;
  let configPath: string | undefined;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      if (!configPath) throw new Error("Invalid --config: expected a path after '='");
    } else if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg} (lsc runs takes only --json and --config=<path>)`);
    else throw new Error(`lsc runs takes no file (got: ${arg})`);
  }
  // Config and log discovery start at a source file's directory, so use a
  // synthetic path under cwd, as `lsc config` does.
  const probe = path.join(process.cwd(), ".lemmascript-runs-probe.ts");
  const { configFile } = loadConfigOptions(probe, configPath);
  const report = runsReport(resolveLogDir(probe, configFile));
  // Missing evidence looks the same whatever the cause, so say when it is git;
  // stderr keeps `--json` output clean.
  if (report.catches.some(c => c.evidence?.diff === null) && !gitAvailable()) {
    console.error("warning: git is not available, so source fixes have no diff or hint");
  }
  console.log(json ? JSON.stringify(report, null, 2) : formatText(report));
}
