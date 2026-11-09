import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/lsc.ts", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const utf16 = "//@ option string-semantics javascript-utf16\n//@ option dafny-library local\n";
const scalar = "//@ option string-semantics unicode-scalar\n//@ option dafny-library stdlib\n";
const library = "export function size(value: string): number { return value.length; }\n";
const caller = 'import { size } from "./library";\nexport function read(): number { return size("😀"); }\n';

function runCli(files: Record<string, string>, args: string[] = ["gen", "source.ts"]) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lsc-file-options-")));
  try {
    for (const [name, source] of Object.entries(files)) {
      const target = join(dir, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const result = spawnSync(process.execPath, ["--import", loader, cli, ...args], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
    });
    assert.ifError(result.error);
    const gen = join(dir, "source.dfy.gen");
    return { ...result, generated: existsSync(gen) ? readFileSync(gen, "utf8") : null,
      proofExists: existsSync(join(dir, "source.dfy")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("lsc config reports file-level options without a project config", () => {
  const result = runCli({ "source.ts": utf16 + library }, ["config", "source.ts"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.configFile, null);
  assert.equal(report.options["string-semantics"], "javascript-utf16");
  assert.equal(report.options["dafny-library"], "local");
});

test("file directives can select scalar/stdlib over project UTF-16/local", () => {
  const result = runCli({
    "lemmascript.json": JSON.stringify({ "string-semantics": "javascript-utf16", "dafny-library": "local" }),
    "source.ts": scalar + library,
  }, ["config", "source.ts"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.options["string-semantics"], "unicode-scalar");
  assert.equal(report.options["dafny-library"], "stdlib");
});

test("a local-library directive completes a UTF-16 project setting before validation", () => {
  const result = runCli({
    "lemmascript.json": '{"string-semantics":"javascript-utf16"}',
    "source.ts": "//@ option dafny-library local\n" + library,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.generated!, /string-semantics=javascript-utf16/);
});

for (const [name, project, directive] of [
  ["default stdlib", "{}", "//@ option string-semantics javascript-utf16\n"],
  ["inherited stdlib", '{"dafny-library":"stdlib"}', "//@ option string-semantics javascript-utf16\n"],
  ["file stdlib", '{"string-semantics":"javascript-utf16","dafny-library":"local"}', "//@ option dafny-library stdlib\n"],
]) {
  test(`UTF-16 rejects ${name} before writing artifacts`, () => {
    const result = runCli({ "lemmascript.json": project, "source.ts": directive + library });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /incompatible.*dafny-library.*stdlib/);
    assert.equal(result.generated, null);
    assert.equal(result.proofExists, false);
  });
}

for (const [name, rootOptions, dependencyOptions] of [
  ["UTF-16 calling scalar", utf16, ""],
  ["scalar calling UTF-16", "", utf16],
]) {
  test(`rejects ${name} with both source paths and models`, () => {
    const result = runCli({ "source.ts": rootOptions + caller, "library.ts": dependencyOptions + library });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source\.ts: string-semantics=.*differs from .*library\.ts/);
    assert.match(result.stderr, /unicode-scalar/);
    assert.match(result.stderr, /javascript-utf16/);
    assert.equal(result.generated, null);
    assert.equal(result.proofExists, false);
  });
}

test("matching UTF-16 dependencies work without reinterpreting unrelated tsconfig files", () => {
  const result = runCli({
    "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
    "source.ts": utf16 + caller, "library.ts": utf16 + library,
    "unrelated.ts": library,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.generated!, /string-semantics=javascript-utf16/);
});

test("scalar dependencies may choose different collection libraries", () => {
  const result = runCli({ "source.ts": caller, "library.ts": "//@ option dafny-library local\n" + library });
  assert.equal(result.status, 0, result.stderr);
});

test("checks compiler-selected global callees without an import edge", () => {
  const result = runCli({
    "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
    "source.ts": utf16 + 'export function read(): number { return size("😀"); }\n',
    "library.ts": library.replace("export ", ""),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from .*library\.ts/);
  assert.equal(result.generated, null);
});

for (const barrel of ["barrel.ts", "barrel.d.ts"]) {
  test(`checks transitive model mismatches through ${barrel}`, () => {
    const result = runCli({
      "source.ts": caller.replace("./library", "./barrel"),
      [barrel]: 'export { size } from "./library";\n',
      "library.ts": utf16 + library,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /differs from .*library\.ts/);
    assert.equal(result.generated, null);
  });
}

test("cycles terminate when all dependency models match", () => {
  const result = runCli({
    "source.ts": caller,
    "library.ts": 'export { read } from "./source";\n' + library,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("nested project configs are checked instead of inheriting the caller's model", () => {
  const result = runCli({
    "source.ts": caller.replace("./library", "./nested/library"),
    "nested/lemmascript.json": '{"string-semantics":"javascript-utf16","dafny-library":"local"}',
    "nested/library.ts": library,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from .*nested\/library\.ts/);
  assert.equal(result.generated, null);
});

test("--config pins the shared project settings for dependencies too", () => {
  const result = runCli({
    "source.ts": caller.replace("./library", "./nested/library"),
    "shared.json": '{"string-semantics":"javascript-utf16","dafny-library":"local"}',
    "nested/lemmascript.json": '{"string-semantics":"unicode-scalar"}',
    "nested/library.ts": library,
  }, ["gen", "--config=shared.json", "source.ts"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.generated!, /string-semantics=javascript-utf16/);
});
