import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { findLakeProjectRoot, leanCheck } from "../src/lean-commands.ts";

function fixture(run: (root: string, source: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "lemmascript-lake project-"));
  const source = path.join(root, "src", "nested space");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(path.join(source, "example.proof.lean"), "-- fixture\n");
    run(root, source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const marker of ["lakefile.lean", "lakefile.toml"]) {
  test(`discovers ${marker} from a nested directory`, () => fixture((root, source) => {
    writeFileSync(path.join(root, marker), "-- marker\n");
    assert.equal(findLakeProjectRoot(source), root);
  }));
  test(`discovers ${marker} in the source directory itself`, () => fixture((_root, source) => {
    writeFileSync(path.join(source, marker), "-- marker\n");
    assert.equal(findLakeProjectRoot(source), source);
  }));
}

for (const [outer, inner] of [
  ["lakefile.lean", "lakefile.toml"],
  ["lakefile.toml", "lakefile.lean"],
]) {
  test(`nearest ${inner} wins over outer ${outer}`, () => fixture((root, source) => {
    writeFileSync(path.join(root, outer), "-- outer\n");
    const nearest = path.dirname(source);
    writeFileSync(path.join(nearest, inner), "-- inner\n");
    assert.equal(findLakeProjectRoot(source), nearest);
  }));
}

test("both markers in one directory identify the same project", () => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.lean"), "-- marker\n");
  writeFileSync(path.join(root, "lakefile.toml"), "-- marker\n");
  assert.equal(findLakeProjectRoot(source), root);
}));

test("relative source paths are resolved before searching", () => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.toml"), "-- marker\n");
  assert.equal(findLakeProjectRoot(path.relative(process.cwd(), source)), root);
}));

for (const marker of ["lakefile.lean", "lakefile.toml"]) {
  test(`checks the filesystem root for ${marker}`, (t) => {
    const root = path.parse(process.cwd()).root;
    t.mock.method(fs, "existsSync", (p: fs.PathLike) => String(p) === path.join(root, marker));
    syncBuiltinESMExports();
    try {
      assert.equal(findLakeProjectRoot(path.join(root, "virtual", "nested")), root);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
}

test("no marker returns null and leanCheck does not spawn Lake", (t) => {
  t.mock.method(fs, "existsSync", (p: fs.PathLike) => String(p).endsWith("example.proof.lean"));
  const spawn = t.mock.method(childProcess, "execFileSync", () => { throw new Error("must not spawn"); });
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => { errors.push(message); });
  syncBuiltinESMExports();
  try {
    assert.equal(findLakeProjectRoot("virtual/source"), null);
    assert.equal(leanCheck("virtual/source", "example"), false);
    assert.equal(spawn.mock.callCount(), 0);
    assert.match(errors.join("\n"), /lakefile\.lean or lakefile\.toml/);
    assert.match(errors.join("\n"), /lake was not started/);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("missing proof files do not launch Lake", (t) => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.toml"), "-- marker\n");
  const spawn = t.mock.method(childProcess, "execFileSync", () => { throw new Error("must not spawn"); });
  syncBuiltinESMExports();
  try {
    assert.equal(leanCheck(source, "missing"), false);
    assert.equal(spawn.mock.callCount(), 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("launches lake build in the discovered project, preserving paths with spaces", (t) => fixture((root, source) => {
  writeFileSync(path.join(root, "lakefile.toml"), "-- marker\n");
  const spawn = t.mock.method(childProcess, "execFileSync", () => Buffer.alloc(0));
  syncBuiltinESMExports();
  try {
    assert.equal(leanCheck(source, "example"), true);
    assert.equal(spawn.mock.callCount(), 1);
    assert.deepEqual(spawn.mock.calls[0].arguments, ["lake", ["build"], { cwd: root, stdio: "inherit" }]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

for (const error of [new Error("lake build failed"), Object.assign(new Error("lake not installed"), { code: "ENOENT" })]) {
  test(`${error.message} returns false`, (t) => fixture((root, source) => {
    writeFileSync(path.join(root, "lakefile.lean"), "-- marker\n");
    t.mock.method(childProcess, "execFileSync", () => { throw error; });
    syncBuiltinESMExports();
    try { assert.equal(leanCheck(source, "example"), false); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }));
}
