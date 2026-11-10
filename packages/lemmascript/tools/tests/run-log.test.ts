import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { dafnyCheckDiff, dafnyRegen, dafnyVerify } from "../src/dafny-commands.ts";
import {
  RunLog, ensureLogDir, hashText, isPartialRun, parseTextLog, readRecords, resolveLogDir, runLogEnabled, safely, snapshotSource,
} from "../src/run-log.ts";

const posixOnly = { skip: process.platform === "win32" };

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "lsc-run-log-test-")));
}

function records(logDir: string): any[] {
  return readFileSync(join(logDir, ".lemmascript", "runs.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
}

/** A complete verify record as JSON, with `id` and any fields overridden (`undefined` removes one). */
function recordLine(id: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1, type: "verify", id, ts: "2026-10-06T01:00:00.000Z", cmd: "check", file: "a.ts", stage: "ok", exit: 0,
    partial: false, failed: [], passed: ["f"], tsHash: "aaaaaaaaaaaa", dfyHash: null, lsc: "0",
    ...overrides,
  });
}

/** The ids `readRecords` keeps from a log made of `lines`. */
function readIds(lines: string[]): string[] {
  const root = tempDir();
  try {
    writeFileSync(join(ensureLogDir(root), "runs.jsonl"), lines.join("\n") + "\n");
    return readRecords(root).map(r => r.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Trimmed from real Dafny 4.11 `--log-format text` output for a broken arraySum.
const TEXT_LOG = `
Results for sumTo (well-formedness)
  Overall outcome: Correct
  Overall time: 00:00:00.0240667

Results for arraySum (well-formedness)
  Overall outcome: Correct

Results for arraySum (correctness)
  Overall outcome: Errors
`;

// A stand-in for `dafny`: writes $FAKE_DAFNY_LOG to the text log path it is
// given (if any, even when empty), creates any CSV log a user asked for, and
// exits with $FAKE_DAFNY_EXIT.
const FAKE_DAFNY = `#!/bin/sh
out=""
for arg in "$@"; do
  case "$arg" in
    "text;LogFileName="*) out="\${arg#text;LogFileName=}" ;;
    "csv;LogFileName="*) : > "\${arg#csv;LogFileName=}" ;;
  esac
done
if [ -n "$out" ] && [ "\${FAKE_DAFNY_LOG+set}" = set ]; then printf '%s' "$FAKE_DAFNY_LOG" > "$out"; fi
exit "\${FAKE_DAFNY_EXIT:-0}"
`;

function withFakeDafny(env: { log?: string; exit?: number }, run: (root: string) => void): void {
  const root = tempDir();
  const saved = { PATH: process.env.PATH, LOG: process.env.FAKE_DAFNY_LOG, EXIT: process.env.FAKE_DAFNY_EXIT };
  try {
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "dafny"), FAKE_DAFNY);
    chmodSync(join(root, "bin", "dafny"), 0o755);
    process.env.PATH = `${join(root, "bin")}${delimiter}${saved.PATH ?? ""}`;
    if (env.log === undefined) delete process.env.FAKE_DAFNY_LOG; else process.env.FAKE_DAFNY_LOG = env.log;
    process.env.FAKE_DAFNY_EXIT = String(env.exit ?? 0);
    run(root);
  } finally {
    for (const [key, value] of [["PATH", saved.PATH], ["FAKE_DAFNY_LOG", saved.LOG], ["FAKE_DAFNY_EXIT", saved.EXIT]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function verifyWithLog(root: string, opts: { extraFlags?: string; proof?: string } = {}): boolean {
  const source = join(root, "a.ts");
  const dfy = join(root, "a.dfy");
  writeFileSync(source, "export const a = 1;\n");
  writeFileSync(dfy, opts.proof ?? "lemma L() {}\n");
  const log = new RunLog({ logDir: root, cmd: "check", sourcePath: source, extraFlags: opts.extraFlags, lscVersion: "0" });
  return dafnyVerify(dfy, root, undefined, opts.extraFlags, log);
}

function checkDiffWithLog(root: string, generated: string, proof: string): boolean {
  const source = join(root, "a.ts");
  const gen = join(root, "a.dfy.gen");
  const dfy = join(root, "a.dfy");
  writeFileSync(source, "");
  writeFileSync(gen, generated);
  writeFileSync(dfy, proof);
  const log = new RunLog({ logDir: root, cmd: "check", sourcePath: source, lscVersion: "0" });
  return dafnyCheckDiff(gen, dfy, log);
}

class ExitSignal extends Error {
  constructor(readonly code: number | undefined) { super(`process.exit(${code})`); }
}

const generation = (n: number): string => `method M() {\n  var value := ${n};\n}\n`;
const addition = "\nlemma AddedProof() {}\n";

/** Run dafnyRegen with process.exit turned into a throw, then return the recorded run. */
function regenRecord(root: string, proof: string, next: string, opts: { base?: string; noVerify?: boolean } = {}): any {
  const f = { gen: join(root, "x.dfy.gen"), proof: join(root, "x.dfy"), base: join(root, "x.dfy.base"), source: join(root, "x.ts") };
  writeFileSync(f.source, "");
  writeFileSync(f.gen, generation(0));
  writeFileSync(f.proof, proof);
  if (opts.base) writeFileSync(f.base, opts.base);
  const log = new RunLog({ logDir: root, cmd: "regen", sourcePath: f.source, lscVersion: "0" });
  const originalExit = process.exit;
  process.exit = ((code?: number) => { throw new ExitSignal(code); }) as typeof process.exit;
  try {
    dafnyRegen(f.gen, f.proof, f.base, next, root, undefined, undefined, opts.noVerify ?? false, log);
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    process.exit = originalExit;
  }
  const all = records(root);
  assert.equal(all.length, 1, "exactly one record per run");
  return all[0];
}

// Parsing, hashing, settings and location.

test("parseTextLog lists each member once, failed if any check failed", () => {
  assert.deepEqual(parseTextLog(TEXT_LOG), { passed: ["sumTo"], failed: ["arraySum"] });
});

test("parseTextLog treats any outcome other than Correct as a failure", () => {
  const log = "Results for slow (correctness)\n  Overall outcome: TimedOut\n";
  assert.deepEqual(parseTextLog(log), { passed: [], failed: ["slow"] });
});

test("parseTextLog returns empty lists for a log with no results", () => {
  assert.deepEqual(parseTextLog(""), { passed: [], failed: [] });
});

test("hashText is a stable 12-character hex prefix", () => {
  assert.equal(hashText("abc"), "ba7816bf8f01");
  assert.match(hashText("anything"), /^[0-9a-f]{12}$/);
});

test("filtered Dafny runs are partial", () => {
  assert.equal(isPartialRun(undefined), false);
  assert.equal(isPartialRun("--isolate-assertions"), false);
  assert.equal(isPartialRun("--filter-symbol=foo"), true);
  assert.equal(isPartialRun("--isolate-assertions --filter-position=x.dfy:3"), true);
});

test("LSC_RUN_LOG=false turns logging off for one run; true or unset defers to config", () => {
  assert.equal(runLogEnabled(true, undefined), true);
  assert.equal(runLogEnabled(false, undefined), false);
  assert.equal(runLogEnabled(true, "false"), false);
  assert.equal(runLogEnabled(true, "true"), true);
  assert.equal(runLogEnabled(false, "true"), false);
  assert.equal(runLogEnabled(true, ""), true);
});

test("LSC_RUN_LOG accepts only true or false, like lemmascript.json", () => {
  for (const value of ["0", "1", "no", "FALSE"]) {
    assert.throws(() => runLogEnabled(true, value), /LSC_RUN_LOG must be true or false/);
  }
});

test("a bad LSC_RUN_LOG is rejected by every file command, not only check and regen", () => {
  const root = tempDir();
  try {
    const source = join(root, "a.ts");
    writeFileSync(source, "export function identity(value: number): number { return value; }\n");
    const cli = fileURLToPath(new URL("../src/lsc.ts", import.meta.url));
    const loader = createRequire(import.meta.url).resolve("tsx");
    const result = spawnSync(process.execPath, ["--import", loader, cli, "gen", "--backend=dafny", source], {
      cwd: root, env: { ...process.env, LSC_RUN_LOG: "0" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /LSC_RUN_LOG must be true or false/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the log lives beside lemmascript.json, else at the git root, else in cwd", () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "src"), { recursive: true });
    const source = join(root, "repo", "src", "a.ts");
    writeFileSync(source, "");
    const config = join(root, "repo", "src", "lemmascript.json");
    assert.equal(resolveLogDir(source, config), join(root, "repo", "src"));
    assert.equal(resolveLogDir(source, null), join(root, "repo"));
    const loose = join(root, "loose.ts");
    writeFileSync(loose, "");
    assert.equal(resolveLogDir(loose, null), process.cwd());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LemmaScript-files.txt takes precedence over the git root, and lemmascript.json over both", () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    mkdirSync(join(root, "repo", "app", "src"), { recursive: true });
    const source = join(root, "repo", "app", "src", "a.ts");
    writeFileSync(source, "");
    writeFileSync(join(root, "repo", "app", "LemmaScript-files.txt"), "src/a.ts\n");
    assert.equal(resolveLogDir(source, null), join(root, "repo", "app"));
    assert.equal(resolveLogDir(source, join(root, "repo", "lemmascript.json")), join(root, "repo"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The log directory, snapshots and records.

test("ensureLogDir creates a self-ignoring directory and keeps an edited .gitignore", () => {
  const root = tempDir();
  try {
    const dir = ensureLogDir(root);
    assert.equal(dir, join(root, ".lemmascript"));
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*\n");
    writeFileSync(join(dir, ".gitignore"), "*\n# kept\n");
    ensureLogDir(root);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*\n# kept\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshotSource stores each distinct version once, named by its hash", () => {
  const root = tempDir();
  try {
    const dir = ensureLogDir(root);
    const hash = snapshotSource(dir, "export const a = 1;\n");
    assert.equal(hash, hashText("export const a = 1;\n"));
    assert.equal(readFileSync(join(dir, "blobs", `${hash}.ts`), "utf8"), "export const a = 1;\n");
    assert.equal(snapshotSource(dir, "export const a = 1;\n"), hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finish appends one complete record and ignores later calls", () => {
  const root = tempDir();
  try {
    const source = join(root, "src", "a.ts");
    mkdirSync(join(root, "src"));
    writeFileSync(source, "export const a = 1;\n");
    const dfy = join(root, "src", "a.dfy");
    writeFileSync(dfy, "lemma L() {}\n");
    const log = new RunLog({ logDir: root, cmd: "check", sourcePath: source, lscVersion: "9.9.9" });
    log.finish({ stage: "verify", exit: 1, dfyPath: dfy, results: { passed: ["a"], failed: ["L"] } });
    log.finish({ stage: "ok", exit: 0, dfyPath: dfy });
    const [r, ...rest] = records(root);
    assert.equal(rest.length, 0);
    assert.deepEqual(Object.keys(r).sort(), [
      "cmd", "dfyHash", "exit", "failed", "file", "id", "lsc", "partial", "passed", "stage", "ts", "tsHash", "type", "v",
    ]);
    assert.equal(r.v, 1);
    assert.equal(r.type, "verify");
    assert.match(r.id, /^[0-9a-f-]{36}$/);
    assert.equal(r.cmd, "check");
    assert.equal(r.file, "src/a.ts");
    assert.equal(r.stage, "verify");
    assert.equal(r.exit, 1);
    assert.equal(r.partial, false);
    assert.deepEqual(r.failed, ["L"]);
    assert.deepEqual(r.passed, ["a"]);
    assert.equal(r.tsHash, hashText("export const a = 1;\n"));
    assert.equal(r.dfyHash, hashText("lemma L() {}\n"));
    assert.equal(r.lsc, "9.9.9");
    assert.ok(existsSync(join(root, ".lemmascript", "blobs", `${r.tsHash}.ts`)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run without member results, or with a filter, is partial", () => {
  const root = tempDir();
  try {
    const source = join(root, "a.ts");
    writeFileSync(source, "");
    new RunLog({ logDir: root, cmd: "regen", sourcePath: source, lscVersion: "0" })
      .finish({ stage: "diff", exit: 1, dfyPath: join(root, "missing.dfy") });
    new RunLog({ logDir: root, cmd: "check", sourcePath: source, extraFlags: "--filter-symbol=a", lscVersion: "0" })
      .finish({ stage: "ok", exit: 0, dfyPath: join(root, "missing.dfy"), results: { passed: ["a"], failed: [] } });
    const [diff, filtered] = records(root);
    assert.equal(diff.partial, true);
    assert.deepEqual(diff.passed, []);
    assert.equal(diff.dfyHash, null);
    assert.equal(filtered.partial, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unwritable log directory never throws", () => {
  const root = tempDir();
  try {
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "a file, so nothing can be created beneath it");
    const source = join(root, "a.ts");
    writeFileSync(source, "");
    const log = new RunLog({ logDir: join(blocker, "sub"), cmd: "check", sourcePath: source, lscVersion: "0" });
    assert.doesNotThrow(() => log.dafnyArgs());
    assert.doesNotThrow(() => log.finish({ stage: "ok", exit: 0, dfyPath: source }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a version that can't be read is recorded as null", () => {
  const root = tempDir();
  try {
    const source = join(root, "a.ts");
    writeFileSync(source, "");
    const lscVersion = safely((): string => { throw new Error("ENOENT: no such file or directory, open 'package.json'"); });
    new RunLog({ logDir: root, cmd: "check", sourcePath: source, lscVersion }).finish({ stage: "ok", exit: 0, dfyPath: source });
    assert.equal(records(root)[0].lsc, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dafnyArgs points Dafny at a temporary text log that readResults parses", () => {
  const root = tempDir();
  try {
    const source = join(root, "a.ts");
    writeFileSync(source, "");
    const log = new RunLog({ logDir: root, cmd: "check", sourcePath: source, lscVersion: "0" });
    assert.equal(log.readResults(), null);
    const args = log.dafnyArgs();
    assert.equal(args[0], "--log-format");
    const file = args[1].replace(/^text;LogFileName=/, "");
    assert.equal(log.readResults(), null);
    writeFileSync(file, TEXT_LOG);
    assert.deepEqual(log.readResults(), { passed: ["sumTo"], failed: ["arraySum"] });
    log.finish({ stage: "verify", exit: 1, dfyPath: source, results: log.readResults() });
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discard ends a run without a record and removes Dafny's temporary results folder", () => {
  const root = tempDir();
  try {
    const source = join(root, "a.ts");
    writeFileSync(source, "");
    const log = new RunLog({ logDir: root, cmd: "check", sourcePath: source, lscVersion: "0" });
    const file = log.dafnyArgs()[1].replace(/^text;LogFileName=/, "");
    const folder = join(file, "..");
    assert.ok(existsSync(folder));
    log.discard();
    log.finish({ stage: "ok", exit: 0, dfyPath: source });
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(join(root, ".lemmascript", "runs.jsonl")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Reading records.

test("readRecords returns verify records in file order", () => {
  assert.deepEqual(readIds([recordLine("a"), recordLine("b")]), ["a", "b"]);
});

test("readRecords skips unparseable lines, other record types and other schema versions", () => {
  assert.deepEqual(readIds([
    recordLine("a"),
    "not json",
    recordLine("b", { type: "claimcheck" }),
    recordLine("c", { v: 2 }),
    recordLine("d"),
    '{"v":1,"type":"veri',
  ]), ["a", "d"]);
});

// A hand-edited line must be skipped like an unparseable one, never crash or invent members.
for (const [name, overrides] of [
  ["no failed list", { failed: undefined }],
  ["failed as a string", { failed: "foo" }],
  ["a non-string member", { passed: ["f", 3] }],
  ["no passed list", { passed: undefined }],
  ["no timestamp", { ts: undefined }],
  ["a timestamp that isn't a date", { ts: "yesterday" }],
  ["no file", { file: undefined }],
  ["a numeric id", { id: 7 }],
  ["no partial flag", { partial: undefined }],
  ["a numeric hash", { tsHash: 5 }],
] as const) {
  test(`readRecords skips a record with ${name}`, () => {
    assert.deepEqual(readIds([recordLine("a"), recordLine("bad", overrides), recordLine("c")]), ["a", "c"]);
  });
}

test("readRecords keeps a record whose hashes are null", () => {
  assert.deepEqual(readIds([recordLine("a", { tsHash: null, dfyHash: null })]), ["a"]);
});

test("readRecords returns no records when there is no log", () => {
  const root = tempDir();
  try {
    assert.deepEqual(readRecords(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Recording `check` runs.

test("a passing verification is recorded as ok with its members", posixOnly, () =>
  withFakeDafny({ log: "Results for L (correctness)\n  Overall outcome: Correct\n", exit: 0 }, root => {
    assert.equal(verifyWithLog(root), true);
    const [r] = records(root);
    assert.equal(r.stage, "ok");
    assert.equal(r.exit, 0);
    assert.deepEqual(r.passed, ["L"]);
    assert.equal(r.partial, false);
  }));

test("a failing verification is recorded as verify with the failed member", posixOnly, () =>
  withFakeDafny({ log: "Results for L (correctness)\n  Overall outcome: Errors\n", exit: 4 }, root => {
    assert.equal(verifyWithLog(root), false);
    const [r] = records(root);
    assert.equal(r.stage, "verify");
    assert.equal(r.exit, 1);
    assert.deepEqual(r.failed, ["L"]);
  }));

test("a Dafny run that writes no results is recorded as resolve", posixOnly, () =>
  withFakeDafny({ exit: 2 }, root => {
    assert.equal(verifyWithLog(root), false);
    const [r] = records(root);
    assert.equal(r.stage, "resolve");
    assert.equal(r.partial, true);
  }));

test("a Dafny resolution error, which writes an empty results file, is recorded as resolve", posixOnly, () =>
  withFakeDafny({ log: "", exit: 2 }, root => {
    assert.equal(verifyWithLog(root), false);
    const [r] = records(root);
    assert.equal(r.stage, "resolve");
    assert.equal(r.partial, true);
  }));

test("a user's own --log-format still reaches Dafny alongside the run log's", posixOnly, () =>
  withFakeDafny({ log: "Results for L (correctness)\n  Overall outcome: Correct\n", exit: 0 }, root => {
    const mine = join(root, "mine.csv");
    assert.equal(verifyWithLog(root, { extraFlags: `--log-format csv;LogFileName=${mine}` }), true);
    assert.ok(existsSync(mine), "the user's CSV log was not written");
    const [r] = records(root);
    assert.equal(r.stage, "ok");
    assert.deepEqual(r.passed, ["L"]);
  }));

test("a proof lsc refuses before running Dafny is recorded as resolve", () => {
  const root = tempDir();
  try {
    // UTF-16 strings with Dafny's standard library: dafnyVerifyArgs refuses this combination.
    const proof = "// lsc options: string-semantics=javascript-utf16\nimport opened Std.Strings\n";
    assert.equal(verifyWithLog(root, { proof }), false);
    const [r] = records(root);
    assert.equal(r.stage, "resolve");
    assert.equal(r.partial, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run where Dafny is not installed is not recorded", posixOnly, () => {
  const root = tempDir();
  const savedPath = process.env.PATH;
  try {
    mkdirSync(join(root, "empty-bin"));
    process.env.PATH = join(root, "empty-bin");
    assert.equal(verifyWithLog(root), false);
    assert.equal(existsSync(join(root, ".lemmascript", "runs.jsonl")), false);
  } finally {
    process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an additions-only failure is recorded as diff", () => {
  const root = tempDir();
  try {
    assert.equal(checkDiffWithLog(root, "method M() {}\n", "method Changed() {}\n"), false);
    const [r] = records(root);
    assert.equal(r.stage, "diff");
    assert.equal(r.exit, 1);
    assert.equal(r.partial, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a passing additions-only check leaves the run open for verification to record", () => {
  const root = tempDir();
  try {
    assert.equal(checkDiffWithLog(root, "method M() {}\n", "method M() {}\nlemma Proof() {}\n"), true);
    assert.equal(existsSync(join(root, ".lemmascript", "runs.jsonl")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Recording `regen` runs.

test("a regen merge conflict is recorded before lsc exits", posixOnly, () =>
  withFakeDafny({ exit: 0 }, root => {
    const r = regenRecord(root, generation(99) + addition, generation(1));
    assert.equal(r.stage, "conflict");
    assert.equal(r.exit, 1);
    assert.equal(r.partial, true);
  }));

test("a regen additions-only failure is recorded as diff", posixOnly, () =>
  withFakeDafny({ exit: 0 }, root => {
    const r = regenRecord(root, generation(99), generation(0), { base: generation(0) });
    assert.equal(r.stage, "diff");
  }));

test("a regen verification failure is recorded as verify", posixOnly, () =>
  withFakeDafny({ log: "Results for M (correctness)\n  Overall outcome: Errors\n", exit: 4 }, root => {
    const r = regenRecord(root, generation(0) + addition, generation(1));
    assert.equal(r.stage, "verify");
    assert.deepEqual(r.failed, ["M"]);
  }));

test("a clean regen --no-verify is recorded as ok but partial", posixOnly, () =>
  withFakeDafny({ exit: 0 }, root => {
    const r = regenRecord(root, generation(0) + addition, generation(2), { noVerify: true });
    assert.equal(r.stage, "ok");
    assert.equal(r.exit, 0);
    assert.equal(r.partial, true);
  }));
