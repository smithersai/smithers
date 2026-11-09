import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/lsc.ts", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const posixOnly = { skip: process.platform === "win32" };

// Run the real CLI against a verifier that records arguments without proving.
// The run log is off unless a test asks for it, so `calls` holds only the
// arguments under test.
function runCli(entries: string[], args: string[], runLog = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-batch-options-")));
  try {
    const bin = join(dir, "bin");
    const log = join(dir, "argv.jsonl");
    mkdirSync(bin);
    writeFileSync(log, "");
    writeFileSync(join(dir, "LemmaScript-files.txt"), entries.join("\n") + "\n");
    for (const entry of entries) {
      const file = entry.split(/\s+/)[0];
      writeFileSync(join(dir, file), "export function identity(value: number): number { return value; }\n");
    }
    writeFileSync(join(bin, "dafny"), `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.LSC_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ["--import", loader, cli, "--backend=dafny", ...args], {
      cwd: dir,
      env: {
        ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, LSC_ARGV_LOG: log,
        LSC_RUN_LOG: runLog ? "true" : "false",
      },
      encoding: "utf8", timeout: 30_000,
    });
    assert.ifError(result.error);
    const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const runsPath = join(dir, ".lemmascript", "runs.jsonl");
    const runs: { file: string }[] = existsSync(runsPath)
      ? readFileSync(runsPath, "utf8").trim().split("\n").map(line => JSON.parse(line))
      : [];
    return { ...result, dir, calls, runs, files: readdirSync(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  { name: "no timeout or flags uses Dafny defaults", entry: "a.ts", flags: [], expected: [] },
  {
    name: "manifest timeout and flags reach Dafny",
    entry: "a.ts 11 --isolate-assertions --cores=1", flags: [],
    expected: ["--verification-time-limit", "11", "--isolate-assertions", "--cores=1"],
  },
  {
    name: "manifest flags work without a timeout",
    entry: "a.ts --isolate-assertions", flags: [], expected: ["--isolate-assertions"],
  },
  {
    name: "CLI values work without manifest values",
    entry: "a.ts", flags: ["--time-limit=17", "--extra-flags=--cores=2 --isolate-assertions"],
    expected: ["--verification-time-limit", "17", "--cores=2", "--isolate-assertions"],
  },
  {
    name: "CLI values replace both manifest values",
    entry: "a.ts 11 --isolate-assertions", flags: ["--time-limit=17", "--extra-flags=--cores=2"],
    expected: ["--verification-time-limit", "17", "--cores=2"],
  },
  {
    name: "overriding only the timeout retains manifest flags",
    entry: "a.ts 11 --isolate-assertions", flags: ["--time-limit=17"],
    expected: ["--verification-time-limit", "17", "--isolate-assertions"],
  },
  {
    name: "overriding only flags retains the manifest timeout",
    entry: "a.ts 11 --isolate-assertions", flags: ["--extra-flags=--cores=2"],
    expected: ["--verification-time-limit", "11", "--cores=2"],
  },
  {
    name: "an empty CLI flag string clears manifest flags",
    entry: "a.ts 11 --isolate-assertions", flags: ["--extra-flags="],
    expected: ["--verification-time-limit", "11"],
  },
  {
    name: "the 60-second manifest boundary still verifies",
    entry: "a.ts 60", flags: [], expected: ["--verification-time-limit", "60"],
  },
  {
    name: "slow enables verification with the manifest timeout",
    entry: "a.ts 120 --isolate-assertions", flags: ["--slow"],
    expected: ["--verification-time-limit", "120", "--isolate-assertions"],
  },
  {
    name: "a short explicit timeout enables a slow manifest entry",
    entry: "a.ts 300 --isolate-assertions", flags: ["--time-limit=17"],
    expected: ["--verification-time-limit", "17", "--isolate-assertions"],
  },
  {
    name: "a long explicit timeout verifies without slow",
    entry: "a.ts 300", flags: ["--time-limit=120"], expected: ["--verification-time-limit", "120"],
  },
  {
    name: "slow does not change an explicit timeout",
    entry: "a.ts 300", flags: ["--slow", "--time-limit=120"], expected: ["--verification-time-limit", "120"],
  },
];

for (const { name, entry, flags, expected } of cases) {
  test(name, posixOnly, () => {
    const result = runCli([entry], ["check", ...flags]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [["verify", ...expected, "--unicode-char:true", join(result.dir, "a.dfy")]]);
  });
}

test("batch overrides apply to every entry, including entries without defaults", posixOnly, () => {
  const result = runCli(["a.ts 300 --isolate-assertions", "b.ts"], ["check", "--time-limit=120", "--extra-flags=--cores=2"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    ["verify", "--verification-time-limit", "120", "--cores=2", "--unicode-char:true", join(result.dir, "a.dfy")],
    ["verify", "--verification-time-limit", "120", "--cores=2", "--unicode-char:true", join(result.dir, "b.dfy")],
  ]);
});

for (const flags of [[], ["--extra-flags=--cores=2"]]) {
  test(`a slow entry still gets gen-check without an explicit timeout: ${JSON.stringify(flags)}`, posixOnly, () => {
    const result = runCli(["a.ts 61 --isolate-assertions", "b.ts 11"], ["check", ...flags]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /a\.ts \(timeout 61s > 60s, gen-check only\)/);
    assert.ok(result.files.includes("a.dfy.gen"));
    assert.deepEqual(result.calls, [[
      "verify", "--verification-time-limit", "11", ...(flags.length ? ["--cores=2"] : []), "--unicode-char:true", join(result.dir, "b.dfy"),
    ]]);
  });
}

test("batch check records one run per verified entry and none for gen-check entries", posixOnly, () => {
  const result = runCli(["a.ts 61", "b.ts 11", "c.ts"], ["check"], true);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.runs.map(r => r.file), ["b.ts", "c.ts"]);
});

test("an explicit file keeps its existing CLI behavior", posixOnly, () => {
  const result = runCli(["a.ts 11 --isolate-assertions"], ["check", "a.ts", "--time-limit=120", "--extra-flags=--cores=2"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [["verify", "--verification-time-limit", "120", "--cores=2", "--unicode-char:true", join(result.dir, "a.dfy")]]);
});

for (const cmd of ["gen", "gen-check"]) {
  test(`${cmd} does not verify even with an explicit timeout`, posixOnly, () => {
    const result = runCli(["a.ts"], [cmd, "--time-limit=120", "--extra-flags=--cores=2"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
    assert.ok(result.files.includes("a.dfy.gen"));
  });
}

for (const value of ["0", "-1", "1.5", "abc", ""]) {
  test(`rejects invalid timeout ${JSON.stringify(value)} before running Dafny`, posixOnly, () => {
    const result = runCli(["a.ts"], ["check", `--time-limit=${value}`]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid --time-limit:/);
    assert.deepEqual(result.calls, []);
  });
}

for (const flags of [
  ["--time-limit=10", "--time-limit=20"],
  ["--extra-flags=--cores=1", "--extra-flags=--cores=2"],
]) {
  test(`rejects repeated flags: ${flags.join(" ")}`, posixOnly, () => {
    const result = runCli(["a.ts"], ["check", ...flags]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`Unknown flag: ${flags[1]}`));
    assert.deepEqual(result.calls, []);
  });
}

for (const cmd of ["regen", "extract"]) {
  test(`rejects unsupported batch command ${cmd}`, posixOnly, () => {
    const result = runCli(["a.ts"], [cmd, "--time-limit=120"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /batch mode supports gen\|gen-check\|check/);
    assert.deepEqual(result.calls, []);
  });
}
