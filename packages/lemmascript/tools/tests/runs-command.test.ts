import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitDafnyFile } from "../src/dafny-emit.ts";
import type { Module } from "../src/ir.ts";
import type { VerifyRecord } from "../src/run-log.ts";
import {
  changeHint, classify, formatText, functionOf, groupByFunction, memberResults, runsReport, snapshotDiff,
  type FunctionResult, type MemberResult, type RunsReport,
} from "../src/runs-command.ts";

const cli = fileURLToPath(new URL("../src/lsc.ts", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const posixOnly = { skip: process.platform === "win32" };

/**
 * A run log built in order: each record gets id `r1`, `r2`, … and a timestamp
 * one minute after the last. Unset fields default to a complete check of `a.ts`.
 */
function log(...records: Partial<VerifyRecord>[]): VerifyRecord[] {
  return records.map((r, i) => {
    const failed = r.failed ?? [];
    return {
      v: 1, type: "verify", id: `r${i + 1}`, ts: new Date(Date.UTC(2026, 9, 6, 1, i)).toISOString(),
      cmd: "check", file: "a.ts", stage: failed.length > 0 ? "verify" : "ok", exit: failed.length > 0 ? 4 : 0,
      partial: false, failed, passed: [], tsHash: "aaaaaaaaaaaa", dfyHash: "bbbbbbbbbbbb", lsc: "0",
      ...r,
    };
  });
}

/** One line per member result (from memberResults): file, member, status and the runs it spans. */
function memberSummary(results: MemberResult[]): string[] {
  return results.map(r => {
    const end = r.fixedRun ?? r.droppedRun;
    return `${r.file} ${r.member} ${r.status} ${r.failedRun.id}${end ? `→${end.id}` : ""}`;
  });
}

/** One line per function result (from groupByFunction): file, function, status, members and the runs it spans. */
function functionSummary(results: FunctionResult[]): string[] {
  return results.map(r => {
    const end = r.fixedRun ?? r.droppedRun;
    return `${r.file} ${r.function} ${r.status} [${r.members.join(",")}] ${r.failedRun.id}${end ? `→${end.id}` : ""}`;
  });
}

/** A project directory with an empty `.lemmascript/blobs/`, removed after `run`. */
function withLogDir(run: (logDir: string, blobs: string) => void): void {
  const logDir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-runs-test-")));
  try {
    const blobs = join(logDir, ".lemmascript", "blobs");
    mkdirSync(blobs, { recursive: true });
    run(logDir, blobs);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
}

/** A one-hunk unified diff of `x.ts` with the given `+`, `-` and context lines. */
function diffOf(...lines: string[]): string {
  return ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,9 +1,9 @@", ...lines, ""].join("\n");
}

// The first agent trial's fix (failing snapshot → passing snapshot): the code
// changed, and the loop invariants describing it changed with it.
const AGENT_TRIAL_DIFF = String.raw`diff --git a/6604d7614b7d.ts b/410875aff690.ts
index 179f419..009d3d2 100644
--- a/6604d7614b7d.ts
+++ b/410875aff690.ts
@@ -19,13 +19,14 @@ export function splitBill(totalCents: number, people: number): number[] {
   //@ ensures sumCents(\result) === totalCents
   //@ ensures forall(i, forall(j, 0 <= i && i < \result.length && 0 <= j && j < \result.length ==> \result[i] - \result[j] <= 1))
   const share = Math.floor(totalCents / people);
+  const remainder = totalCents - share * people;
   const shares: number[] = [];
   for (let i = 0; i < people; i++) {
     //@ invariant 0 <= i && i <= people
     //@ invariant shares.length === i
-    //@ invariant forall(k, 0 <= k && k < shares.length ==> shares[k] === share)
-    //@ invariant sumCents(shares) === share * i
-    shares.push(share);
+    //@ invariant forall(k, 0 <= k && k < shares.length ==> shares[k] === share || shares[k] === share + 1)
+    //@ invariant sumCents(shares) === share * i + (i < remainder ? i : remainder)
+    shares.push(i < remainder ? share + 1 : share);
   }
   return shares;
 }
`;

/** Write `records` as the project's runs.jsonl. */
function writeLog(logDir: string, records: VerifyRecord[]): void {
  writeFileSync(join(logDir, ".lemmascript", "runs.jsonl"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
}

/** A report for formatText: three runs of splitBill.ts on 6 October (UTC), nothing caught unless overridden. */
function textReport(overrides: Partial<RunsReport>): RunsReport {
  return {
    v: 1, log: "/project/.lemmascript/runs.jsonl", runs: 3, files: 1,
    from: "2026-10-06T14:13:22.844Z", to: "2026-10-06T14:17:20.016Z",
    counts: { catches: 0, sourceFix: 0, proof: 0, flaky: 0, open: 0, dropped: 0 },
    catches: [], open: [], dropped: [],
    ...overrides,
  };
}

// The agent trial's catch, as the report gives it.
const SPLIT_BILL_CATCH: RunsReport["catches"][number] = {
  id: "r1:splitBill", file: "splitBill.ts", function: "splitBill", members: ["splitBill"], kind: "source-fix",
  failedAt: "2026-10-06T14:13:22.844Z", failedRun: "r1", fixedAt: "2026-10-06T14:17:18.737Z", fixedRun: "r2",
  evidence: { hint: "code", diff: AGENT_TRIAL_DIFF },
};

/** Run the real `lsc` with `args` in `cwd`. */
function lsc(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ["--import", loader, cli, ...args], {
    cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}

/** A log of one source-fix catch of `f` in `a.ts` (failed, then fixed with a changed `.ts`), with both snapshots. */
function writeCatchLog(logDir: string): void {
  const blobs = join(logDir, ".lemmascript", "blobs");
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, "aaaaaaaaaaaa.ts"), "return 1;\n");
  writeFileSync(join(blobs, "cccccccccccc.ts"), "return 2;\n");
  writeLog(logDir, log({ failed: ["f"] }, { passed: ["f"], tsHash: "cccccccccccc" }));
}

// Member results: each Dafny member's failure streaks, marked caught, open or dropped.

test("a failure followed by a pass is one catch", () => {
  assert.deepEqual(memberSummary(memberResults(log({ failed: ["f"] }, { passed: ["f"] }))), ["a.ts f caught r1→r2"]);
});

test("a streak of failures ending in a pass is one catch starting at the first failure", () => {
  const records = log({ failed: ["f"] }, { failed: ["f"] }, { failed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r1→r4"]);
});

test("a partial run that does not mention the member is skipped", () => {
  const records = log({ failed: ["f"] }, { partial: true, passed: ["g"] }, { passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r1→r3"]);
});

test("a complete run without a failing member drops the failure", () => {
  const records = log({ failed: ["f"] }, { passed: ["g"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f dropped r1→r2"]);
});

test("a partial run without a failing member never drops it", () => {
  const records = log({ failed: ["f"] }, { partial: true, stage: "diff", exit: 1 }, { partial: true, passed: ["g"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f open r1"]);
});

test("a failure with no later pass is open", () => {
  assert.deepEqual(memberSummary(memberResults(log({ passed: ["f"] }, { failed: ["f"] }))), ["a.ts f open r2"]);
});

test("two separate fail-then-pass streaks are two catches", () => {
  const records = log({ failed: ["f"] }, { passed: ["f"] }, { failed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r1→r2", "a.ts f caught r3→r4"]);
});

test("files are independent: a run of one file never passes or drops another file's member", () => {
  const records = log({ file: "a.ts", failed: ["f"] }, { file: "b.ts", passed: ["f"] }, { file: "a.ts", passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r1→r3"]);
});

test("repeated passes add nothing", () => {
  const records = log({ passed: ["f"] }, { failed: ["f"] }, { passed: ["f"] }, { passed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r2→r3"]);
});

test("a member that failed in a filtered run still counts as failed", () => {
  const records = log({ partial: true, failed: ["f"] }, { passed: ["f"] });
  assert.deepEqual(memberSummary(memberResults(records)), ["a.ts f caught r1→r2"]);
});

// Grouping by TypeScript function: a function's Dafny members (foo, foo_ensures) count as one catch; lsc's generated helpers don't count.

for (const [member, fn] of [
  ["splitBill", "splitBill"],
  ["splitBill_ensures", "splitBill"],
  ["Counter.inc_ensures", "Counter.inc"],
  ["JSFloorDiv", null],
  ["SetToSeq", null],
  ["sumIsMonotone", "sumIsMonotone"],
] as const) {
  test(`functionOf maps ${member} to ${fn ?? "nothing (a generated helper)"}`, () => {
    assert.equal(functionOf(member), fn);
  });
}

test("functionOf maps the ensures lemma the Dafny emitter generates back to its function", () => {
  const double: Module = { comment: "", imports: [], options: [], decls: [{
    kind: "def", name: "double", typeParams: [], params: [{ name: "n", type: { kind: "int" } }], returnType: { kind: "int" },
    requires: [], ensures: [{ kind: "bool", value: true }], decreases: null,
    body: { kind: "binop", op: "+", left: { kind: "var", name: "n" }, right: { kind: "var", name: "n" } },
  }] };
  const lemmas = [...emitDafnyFile(double, "double.ts").matchAll(/^lemma (\w+)/gm)].map(m => m[1]);
  assert.deepEqual(lemmas.map(functionOf), ["double"]);
});

test("a function and its ensures lemma fixed by the same run are one catch from the earliest failure", () => {
  const records = log({ failed: ["foo_ensures"], passed: ["foo"] }, { failed: ["foo", "foo_ensures"] }, { passed: ["foo", "foo_ensures"] });
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), ["a.ts foo caught [foo,foo_ensures] r1→r3"]);
});

test("a function stays caught until its last failing member passes", () => {
  const records = log({ failed: ["foo", "foo_ensures"] }, { failed: ["foo_ensures"], passed: ["foo"] }, { passed: ["foo", "foo_ensures"] });
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), ["a.ts foo caught [foo,foo_ensures] r1→r3"]);
});

test("a member that starts failing as another is fixed continues the same catch", () => {
  const records = log({ failed: ["foo"], passed: ["foo_ensures"] }, { failed: ["foo_ensures"], passed: ["foo"] }, { passed: ["foo", "foo_ensures"] });
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), ["a.ts foo caught [foo,foo_ensures] r1→r3"]);
});

test("a function that passed between two failures is caught twice, with different ids", () => {
  const records = log(
    { failed: ["foo"], passed: ["foo_ensures"] }, { passed: ["foo", "foo_ensures"] },
    { failed: ["foo_ensures"], passed: ["foo"] }, { passed: ["foo", "foo_ensures"] },
  );
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), [
    "a.ts foo caught [foo] r1→r2",
    "a.ts foo caught [foo_ensures] r3→r4",
  ]);
});

test("a function with a member still failing is open, not caught", () => {
  const records = log({ failed: ["foo", "foo_ensures"] }, { failed: ["foo_ensures"], passed: ["foo"] });
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), ["a.ts foo open [foo,foo_ensures] r1"]);
});

test("a function fixed in the run that drops its ensures lemma is caught", () => {
  const records = log({ failed: ["foo", "foo_ensures"] }, { passed: ["foo"] });
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), ["a.ts foo caught [foo,foo_ensures] r1→r2"]);
});

test("generated helpers are left out of catches", () => {
  const records = log({ failed: ["JSFloorDiv", "f"] }, { passed: ["JSFloorDiv", "f"] });
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), ["a.ts f caught [f] r1→r2"]);
});

test("open and dropped failures are grouped by file and function", () => {
  const records = log(
    { file: "a.ts", failed: ["g", "g_ensures"] },
    { file: "b.ts", failed: ["h"], passed: ["h_ensures"] }, { file: "b.ts", failed: ["h", "h_ensures"] }, { file: "b.ts", passed: ["x"] },
  );
  assert.deepEqual(functionSummary(groupByFunction(memberResults(records))), [
    "a.ts g open [g,g_ensures] r1",
    "b.ts h dropped [h,h_ensures] r2→r4",
  ]);
});

// Kinds of catch: what changed between the first failing run and the passing run (.ts, only .dfy, or nothing).

for (const [name, failed, fixed, kind] of [
  ["a changed .ts is a source fix", { tsHash: "aaaaaaaaaaaa" }, { tsHash: "cccccccccccc", dfyHash: "dddddddddddd" }, "source-fix"],
  ["a changed .dfy alone is a proof fix", {}, { dfyHash: "dddddddddddd" }, "proof"],
  ["no change is flaky", {}, {}, "flaky"],
] as const) {
  test(`classify: ${name}`, () => {
    const [a, b] = log(failed, fixed);
    assert.equal(classify(a, b), kind);
  });
}

test("classify compares the first failing run, not the last, with the passing run", () => {
  const records = log({ failed: ["f"], tsHash: "aaaaaaaaaaaa" }, { failed: ["f"], tsHash: "cccccccccccc" }, { passed: ["f"], tsHash: "cccccccccccc" });
  const [caught] = memberResults(records);
  assert.equal(classify(caught.failedRun, caught.fixedRun!), "source-fix");
});

// Evidence for source fixes: the diff between the two .ts snapshots, and a hint at what the fix changed.

test("snapshotDiff gives the unified diff from the failing snapshot to the passing one", () =>
  withLogDir((logDir, blobs) => {
    writeFileSync(join(blobs, "aaaaaaaaaaaa.ts"), "const a = 1;\n");
    writeFileSync(join(blobs, "cccccccccccc.ts"), "const a = 2;\n");
    const diff = snapshotDiff(logDir, "aaaaaaaaaaaa", "cccccccccccc");
    assert.match(diff ?? "", /^diff --git a\/aaaaaaaaaaaa\.ts b\/cccccccccccc\.ts\n/);
    assert.match(diff ?? "", /^-const a = 1;$/m);
    assert.match(diff ?? "", /^\+const a = 2;$/m);
  }));

test("snapshotDiff gives null when a snapshot is missing", () =>
  withLogDir((logDir, blobs) => {
    writeFileSync(join(blobs, "aaaaaaaaaaaa.ts"), "const a = 1;\n");
    assert.equal(snapshotDiff(logDir, "aaaaaaaaaaaa", "cccccccccccc"), null);
    assert.equal(snapshotDiff(logDir, null, "aaaaaaaaaaaa"), null);
  }));

// Each bad hash names a file that exists, so only the hash check can keep it out.
for (const hash of ["../x", "-rf", "ABCDEF123456", "aaaaaaaaaaa", "aaaaaaaaaaaaa"]) {
  test(`snapshotDiff refuses the hash ${JSON.stringify(hash)} without reading the file it names`, () =>
    withLogDir((logDir, blobs) => {
      writeFileSync(join(blobs, "aaaaaaaaaaaa.ts"), "const a = 1;\n");
      writeFileSync(join(blobs, `${hash}.ts`), "const a = 2;\n");
      assert.equal(snapshotDiff(logDir, "aaaaaaaaaaaa", hash), null);
      assert.equal(snapshotDiff(logDir, hash, "aaaaaaaaaaaa"), null);
    }));
}

for (const [name, diff, hint] of [
  ["a changed line of code", diffOf("-  return a;", "+  return b;"), "code"],
  ["code with the invariants that describe it (the first agent trial)", AGENT_TRIAL_DIFF, "code"],
  ["a removed decrement, which starts with ---", diffOf("---count;", " return count;"), "code"],
  ["only an ensures", diffOf("-  //@ ensures \\result >= 0", "+  //@ ensures \\result > 0"), "spec"],
  ["only a contract", diffOf("+  //@ contract Returns the larger value"), "spec"],
  ["a requires and code", diffOf("+  //@ requires n > 0", "-  return 0;", "+  return 1;"), "mixed"],
  ["only invariant, decreases and assert lines", diffOf("+    //@ invariant i <= n", "+    //@ decreases n - i", "+    //@ assert i >= 0"), "proof"],
  ["only comments", diffOf("-  // old note", "+  // new note", "+  /* block */", "+   * more"), "proof"],
  ["only blank lines", diffOf("+", "+   "), "proof"],
  ["unchanged context lines, whatever they hold", diffOf("   return a;", "   //@ ensures x", "+  // note"), "proof"],
] as const) {
  test(`changeHint: ${name} → ${hint}`, () => {
    assert.equal(changeHint(diff), hint);
  });
}

// The report: the whole log as data, which `lsc runs --json` prints as is.

test("runsReport reports the agent trial's fix as one source-fix catch with its diff and hint", () =>
  withLogDir((logDir, blobs) => {
    writeFileSync(join(blobs, "6604d7614b7d.ts"), "const shares = [share];\n");
    writeFileSync(join(blobs, "410875aff690.ts"), "const remainder = total - share * people;\nconst shares = [share + 1];\n");
    const members = ["JSFloorDiv", "splitBill", "sumCents"];
    writeLog(logDir, log(
      { file: "splitBill.ts", failed: ["splitBill"], passed: ["JSFloorDiv", "sumCents"], tsHash: "6604d7614b7d" },
      { file: "splitBill.ts", cmd: "regen", passed: members, tsHash: "410875aff690", dfyHash: "cccccccccccc" },
      { file: "splitBill.ts", passed: members, tsHash: "410875aff690", dfyHash: "cccccccccccc" },
    ));
    assert.deepEqual(runsReport(logDir), {
      v: 1, log: join(logDir, ".lemmascript", "runs.jsonl"), runs: 3, files: 1,
      from: "2026-10-06T01:00:00.000Z", to: "2026-10-06T01:02:00.000Z",
      counts: { catches: 1, sourceFix: 1, proof: 0, flaky: 0, open: 0, dropped: 0 },
      catches: [{
        id: "r1:splitBill", file: "splitBill.ts", function: "splitBill", members: ["splitBill"], kind: "source-fix",
        failedAt: "2026-10-06T01:00:00.000Z", failedRun: "r1", fixedAt: "2026-10-06T01:01:00.000Z", fixedRun: "r2",
        evidence: { hint: "code", diff: snapshotDiff(logDir, "6604d7614b7d", "410875aff690") },
      }],
      open: [], dropped: [],
    });
  }));

test("runsReport orders catches by fix time and open or dropped failures by failure time", () =>
  withLogDir(logDir => {
    writeLog(logDir, log(
      { file: "a.ts", failed: ["p"] },
      { file: "b.ts", failed: ["q"] },
      { file: "b.ts", passed: ["q"] },                              // q: nothing changed → flaky
      { file: "a.ts", passed: ["p"], dfyHash: "dddddddddddd" },     // p: only the proof changed
      { file: "c.ts", passed: ["o"] },
      { file: "d.ts", failed: ["x"] },
      { file: "c.ts", failed: ["o"] },
      { file: "e.ts", failed: ["g"] },
      { file: "e.ts", passed: ["h"] },                              // g is gone → dropped
    ));
    const report = runsReport(logDir);
    assert.equal(report.files, 5);
    assert.deepEqual(report.counts, { catches: 2, sourceFix: 0, proof: 1, flaky: 1, open: 2, dropped: 1 });
    assert.deepEqual(report.catches.map(c => `${c.function} ${c.kind}`), ["q flaky", "p proof"]);
    assert.ok(report.catches.every(c => !("evidence" in c)), "only source fixes carry evidence");
    assert.deepEqual(report.open.map(o => o.function), ["x", "o"]);
    assert.ok(report.open.every(o => !("droppedRun" in o)));
    assert.deepEqual(report.dropped, [
      { file: "e.ts", function: "g", members: ["g"], failedAt: "2026-10-06T01:07:00.000Z", failedRun: "r8", droppedRun: "r9" },
    ]);
  }));

test("runsReport gives a source fix with a missing snapshot null evidence", () =>
  withLogDir(logDir => {
    writeLog(logDir, log({ failed: ["f"] }, { passed: ["f"], tsHash: "cccccccccccc" }));
    assert.deepEqual(runsReport(logDir).catches[0].evidence, { hint: null, diff: null });
  }));

test("runsReport on a project with no log reports zero runs", () =>
  withLogDir(logDir => {
    assert.deepEqual(runsReport(logDir), {
      v: 1, log: join(logDir, ".lemmascript", "runs.jsonl"), runs: 0, files: 0, from: null, to: null,
      counts: { catches: 0, sourceFix: 0, proof: 0, flaky: 0, open: 0, dropped: 0 },
      catches: [], open: [], dropped: [],
    });
  }));

// Text summary: what `lsc runs` prints, built only from the report.

test("formatText summarises a source fix with its times and hint", () => {
  const report = textReport({ counts: { catches: 1, sourceFix: 1, proof: 0, flaky: 0, open: 0, dropped: 0 }, catches: [SPLIT_BILL_CATCH] });
  assert.equal(formatText(report, "UTC"), [
    "3 runs, 1 file, 2026-10-06 14:13 → 14:17",
    "",
    "catches: 1   (source-fix 1, proof 0, flaky 0)",
    "open: 0   dropped: 0",
    "",
    "source-fix  splitBill.ts  splitBill  failed 14:13, fixed 14:17  hint: code",
  ].join("\n"));
});

test("formatText lists open and dropped failures after catches, with the date they first failed", () => {
  const report = textReport({
    files: 2,
    counts: { catches: 1, sourceFix: 0, proof: 1, flaky: 0, open: 1, dropped: 1 },
    catches: [{
      id: "r1:sumCents", file: "splitBill.ts", function: "sumCents", members: ["sumCents_ensures"], kind: "proof",
      failedAt: "2026-10-06T14:13:22.844Z", failedRun: "r1", fixedAt: "2026-10-06T14:17:18.737Z", fixedRun: "r2",
    }],
    open: [{ file: "splitBill.ts", function: "splitBill", members: ["splitBill"], failedAt: "2026-10-06T14:15:00.000Z", failedRun: "r3" }],
    dropped: [{ file: "old.ts", function: "legacy", members: ["legacy"], failedAt: "2026-10-06T14:14:00.000Z", failedRun: "r4", droppedRun: "r5" }],
  });
  assert.equal(formatText(report, "UTC"), [
    "3 runs, 2 files, 2026-10-06 14:13 → 14:17",
    "",
    "catches: 1   (source-fix 0, proof 1, flaky 0)",
    "open: 1   dropped: 1",
    "",
    "proof    splitBill.ts  sumCents   failed 14:13, fixed 14:17",
    "open     splitBill.ts  splitBill  failed 2026-10-06 14:15",
    "dropped  old.ts        legacy     failed 2026-10-06 14:14",
  ].join("\n"));
});

test("formatText shows dates when the log spans more than one day", () => {
  const catchNextDay = { ...SPLIT_BILL_CATCH, fixedAt: "2026-10-07T09:00:00.000Z" };
  const report = textReport({ to: "2026-10-07T09:00:00.000Z", counts: { catches: 1, sourceFix: 1, proof: 0, flaky: 0, open: 0, dropped: 0 }, catches: [catchNextDay] });
  const lines = formatText(report, "UTC").split("\n");
  assert.equal(lines[0], "3 runs, 1 file, 2026-10-06 14:13 → 2026-10-07 09:00");
  assert.equal(lines[lines.length - 1],"source-fix  splitBill.ts  splitBill  failed 2026-10-06 14:13, fixed 2026-10-07 09:00  hint: code");
});

test("formatText shows times in the time zone it is given", () => {
  assert.equal(formatText(textReport({}), "Pacific/Auckland"), [
    "3 runs, 1 file, 2026-10-07 03:13 → 03:17",
    "",
    "catches: 0   (source-fix 0, proof 0, flaky 0)",
    "open: 0   dropped: 0",
  ].join("\n"));
});

test("formatText counts one run and one file in the singular", () => {
  assert.match(formatText(textReport({ runs: 1, files: 1 }), "UTC"), /^1 run, 1 file, /);
});

test("formatText says so when no runs are recorded", () => {
  const report = textReport({ runs: 0, files: 0, from: null, to: null });
  assert.equal(formatText(report, "UTC"), "No runs recorded yet in /project/.lemmascript/runs.jsonl.");
});

// The `lsc runs` command, through the real CLI.

test("lsc runs prints the summary of the log beside lemmascript.json", () =>
  withLogDir(dir => {
    writeFileSync(join(dir, "lemmascript.json"), "{}\n");
    writeCatchLog(dir);
    const result = lsc(dir, ["runs"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^2 runs, 1 file, /);
    assert.match(result.stdout, /^source-fix {2}a\.ts {2}f {2}failed .*hint: code$/m);
  }));

test("lsc runs --json prints the report as JSON", () =>
  withLogDir(dir => {
    writeFileSync(join(dir, "lemmascript.json"), "{}\n");
    writeCatchLog(dir);
    const result = lsc(dir, ["runs", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.log, join(dir, ".lemmascript", "runs.jsonl"));
    assert.deepEqual(report.counts, { catches: 1, sourceFix: 1, proof: 0, flaky: 0, open: 0, dropped: 0 });
    assert.equal(result.stderr, "");
  }));

test("without git, lsc runs warns that source fixes have no diff, and the JSON stays clean", posixOnly, () =>
  withLogDir(dir => {
    writeFileSync(join(dir, "lemmascript.json"), "{}\n");
    writeCatchLog(dir);
    mkdirSync(join(dir, "no-git"));
    const result = lsc(dir, ["runs", "--json"], { PATH: join(dir, "no-git") });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).catches[0].evidence, { hint: null, diff: null });
    assert.match(result.stderr, /^warning: git is not available, so source fixes have no diff or hint\n$/);
  }));

test("lsc runs --config reads the log beside the chosen lemmascript.json", () =>
  withLogDir(dir => {
    mkdirSync(join(dir, "project", ".lemmascript"), { recursive: true });
    mkdirSync(join(dir, "elsewhere"));
    writeFileSync(join(dir, "project", "lemmascript.json"), "{}\n");
    writeFileSync(join(dir, "elsewhere", "lemmascript.json"), "{}\n");
    writeCatchLog(join(dir, "project"));
    const result = lsc(join(dir, "elsewhere"), ["runs", "--json", "--config=../project/lemmascript.json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).log, join(dir, "project", ".lemmascript", "runs.jsonl"));
  }));

test("without lemmascript.json, lsc runs reads the log beside LemmaScript-files.txt", () =>
  withLogDir(dir => {
    writeFileSync(join(dir, "LemmaScript-files.txt"), "a.ts\n");
    mkdirSync(join(dir, "src"));
    writeCatchLog(dir);
    const result = lsc(join(dir, "src"), ["runs", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).log, join(dir, ".lemmascript", "runs.jsonl"));
  }));

test("lsc runs still reads the log when recording is turned off", () =>
  withLogDir(dir => {
    writeFileSync(join(dir, "lemmascript.json"), JSON.stringify({ "run-log": false }) + "\n");
    writeCatchLog(dir);
    const result = lsc(dir, ["runs", "--json"], { LSC_RUN_LOG: "false" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).counts.catches, 1);
  }));

test("lsc runs with no log says no runs are recorded yet", () =>
  withLogDir(dir => {
    writeFileSync(join(dir, "lemmascript.json"), "{}\n");
    const result = lsc(dir, ["runs"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `No runs recorded yet in ${join(dir, ".lemmascript", "runs.jsonl")}.\n`);
  }));

for (const arg of ["--all", "--backend=lean", "--bogus"]) {
  test(`lsc runs rejects ${arg}`, () =>
    withLogDir(dir => {
      const result = lsc(dir, ["runs", arg]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`Unknown flag: ${arg}`));
      assert.equal(result.stdout, "");
    }));
}

test("lsc runs rejects a file argument", () =>
  withLogDir(dir => {
    const result = lsc(dir, ["runs", "a.ts"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lsc runs takes no file/);
  }));

test("--json is still an unknown flag for other commands", () =>
  withLogDir(dir => {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    const result = lsc(dir, ["check", "--json", "a.ts"], { LSC_RUN_LOG: "false" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown flag: --json/);
  }));
